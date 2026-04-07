# Phase 13 — 失敗恢復管線需求文檔

> **狀態**: 設計完成  
> **優先級**: P1 — Wave 3 持久化與治理  
> **前置依賴**: Phase 1（上下文壓縮）、Phase 3（全文持久化）  
> **後置被依賴**: 無

---

## 1. 問題陳述

在長時間運行的 Agent 會話中，錯誤是不可避免的。API 超時、token 溢出、權限拒絕、Hook 阻斷——這些不是例外情況，而是常態。

沒有恢復機制的 Agent 在遇到錯誤時只有兩個選擇：崩潰或忽略。這兩者都不可接受。

**核心原則**：錯誤是決策點，而非終點。每種錯誤都有對應的恢復策略。

---

## 2. 錯誤分類

```typescript
type ErrorCategory =
  | "tool_input_error"     // 工具輸入校驗失敗
  | "permission_denied"    // 權限被拒絕
  | "hook_blocked"         // 被 Hook 阻斷
  | "prompt_too_long"      // 提示詞超出上下文視窗
  | "max_output_tokens"    // 輸出達到 token 上限（被截斷）
  | "model_api_error"      // 模型 API 一般錯誤（400/500 等）
  | "model_overloaded"     // 模型過載（429/529）
  | "catastrophic";        // 無法分類或無法恢復的嚴重錯誤

interface ClassifiedError {
  category: ErrorCategory;
  originalError: Error;
  message: string;
  recoverable: boolean;
  severity: "light" | "medium" | "heavy";
}
```

### 2.1 分類邏輯

```typescript
function classifyError(error: Error): ClassifiedError {
  // 工具輸入錯誤
  if (error instanceof z.ZodError) {
    return {
      category: "tool_input_error",
      originalError: error,
      message: `工具輸入校驗失敗: ${formatZodError(error)}`,
      recoverable: true,
      severity: "light",
    };
  }
  
  // 權限拒絕
  if (error instanceof PermissionDeniedError) {
    return {
      category: "permission_denied",
      originalError: error,
      message: `權限被拒絕: ${error.message}`,
      recoverable: true,
      severity: "light",
    };
  }
  
  // Hook 阻斷
  if (error instanceof HookBlockedError) {
    return {
      category: "hook_blocked",
      originalError: error,
      message: `被 Hook 阻斷: ${error.reason}`,
      recoverable: true,
      severity: "light",
    };
  }
  
  // Prompt 太長
  if (isPromptTooLongError(error)) {
    return {
      category: "prompt_too_long",
      originalError: error,
      message: "提示詞超出上下文視窗限制",
      recoverable: true,
      severity: "medium",
    };
  }
  
  // 輸出 token 達到上限
  if (isMaxOutputTokensError(error)) {
    return {
      category: "max_output_tokens",
      originalError: error,
      message: "模型輸出被截斷（達到 max_output_tokens）",
      recoverable: true,
      severity: "medium",
    };
  }
  
  // 模型過載
  if (isOverloadedError(error)) {
    return {
      category: "model_overloaded",
      originalError: error,
      message: "模型服務過載，需要退避重試",
      recoverable: true,
      severity: "medium",
    };
  }
  
  // 一般 API 錯誤
  if (isAPIError(error)) {
    return {
      category: "model_api_error",
      originalError: error,
      message: `API 錯誤: ${error.message}`,
      recoverable: true,
      severity: "medium",
    };
  }
  
  // 無法分類 → 嚴重錯誤
  return {
    category: "catastrophic",
    originalError: error,
    message: `未預期的錯誤: ${error.message}`,
    recoverable: false,
    severity: "heavy",
  };
}
```

---

## 3. 三級恢復策略

### 3.1 Light（輕量恢復）

適用於：`tool_input_error`、`permission_denied`、`hook_blocked`

策略：**回傳錯誤訊息給模型**，讓模型自行修正。

```typescript
async function lightRecover(
  classified: ClassifiedError,
  ctx: RecoveryContext
): Promise<RecoveryResult> {
  // 將錯誤訊息作為工具結果回傳給模型
  const errorMessage = formatErrorForModel(classified);
  
  return {
    action: "inject_error",
    message: errorMessage,
    continueLoop: true, // 繼續主迴圈
  };
}

function formatErrorForModel(classified: ClassifiedError): string {
  switch (classified.category) {
    case "tool_input_error":
      return `工具呼叫失敗：輸入參數無效。\n${classified.message}\n` +
        `請修正參數後重試。`;
    
    case "permission_denied":
      return `工具呼叫被拒絕：${classified.message}\n` +
        `請使用其他方式完成此操作，或詢問使用者授權。`;
    
    case "hook_blocked":
      return `操作被安全策略阻斷：${classified.message}\n` +
        `請調整操作方式以符合安全策略。`;
    
    default:
      return `錯誤：${classified.message}`;
  }
}
```

### 3.2 Medium（中等恢復）

適用於：`prompt_too_long`、`max_output_tokens`、`model_api_error`、`model_overloaded`

策略：**系統級介入**，包括壓縮、續寫、退避重試。

```typescript
async function mediumRecover(
  classified: ClassifiedError,
  ctx: RecoveryContext
): Promise<RecoveryResult> {
  switch (classified.category) {
    case "prompt_too_long":
      return await recoverPromptTooLong(ctx);
    
    case "max_output_tokens":
      return await recoverMaxOutputTokens(ctx);
    
    case "model_overloaded":
      return await recoverOverloaded(ctx);
    
    case "model_api_error":
      return await recoverAPIError(classified, ctx);
    
    default:
      throw new Error(`Medium 恢復不支援: ${classified.category}`);
  }
}
```

#### prompt_too_long 恢復

```typescript
async function recoverPromptTooLong(
  ctx: RecoveryContext
): Promise<RecoveryResult> {
  // 觸發反應式壓縮（Phase 1）
  const compacted = await reactiveCompact(
    ctx.session.messages,
    ctx.session
  );
  
  ctx.session.messages = compacted;
  
  return {
    action: "retry",
    message: null,
    continueLoop: true,
  };
}
```

#### max_output_tokens 續寫

```typescript
const MAX_CONTINUATIONS = 3;

async function recoverMaxOutputTokens(
  ctx: RecoveryContext
): Promise<RecoveryResult> {
  if (ctx.continuationCount >= MAX_CONTINUATIONS) {
    return {
      action: "inject_error",
      message: "輸出多次被截斷（已重試 3 次）。請嘗試將任務分解為更小的步驟。",
      continueLoop: true,
    };
  }
  
  // 注入續寫提示
  ctx.session.messages.push({
    role: "user",
    content: "Continue exactly where you left off. Do not repeat any content.",
  });
  
  ctx.continuationCount++;
  
  return {
    action: "retry",
    message: null,
    continueLoop: true,
  };
}
```

#### 過載退避

```typescript
async function recoverOverloaded(
  ctx: RecoveryContext
): Promise<RecoveryResult> {
  const baseDelay = 1000; // 1 秒
  const maxDelay = 30000; // 30 秒
  const attempt = ctx.retryCount;
  
  // 指數退避 + 隨機抖動
  const delay = Math.min(
    baseDelay * Math.pow(2, attempt) + Math.random() * 1000,
    maxDelay
  );
  
  console.log(`[恢復] 模型過載，${Math.round(delay / 1000)} 秒後重試...`);
  await sleep(delay);
  
  ctx.retryCount++;
  
  return {
    action: "retry",
    message: null,
    continueLoop: true,
  };
}
```

### 3.3 Heavy（重度恢復）

適用於：`catastrophic`

策略：**儲存現場、嘗試重建、最終終止**。

```typescript
async function heavyRecover(
  classified: ClassifiedError,
  ctx: RecoveryContext
): Promise<RecoveryResult> {
  // 步驟 1：緊急儲存 Transcript
  try {
    await transcriptStore.save(
      ctx.session.id,
      ctx.session.messages
    );
    console.log("[恢復] Transcript 已緊急儲存");
  } catch (saveError) {
    console.error("[恢復] Transcript 儲存失敗:", saveError);
  }
  
  // 步驟 2：嘗試重建會話
  try {
    const rebuilt = await rebuildSession(ctx.session);
    if (rebuilt) {
      ctx.session.messages = rebuilt.messages;
      return {
        action: "retry",
        message: null,
        continueLoop: true,
      };
    }
  } catch (rebuildError) {
    console.error("[恢復] 會話重建失敗:", rebuildError);
  }
  
  // 步驟 3：無法恢復，終止會話
  return {
    action: "terminate",
    message: `無法恢復的錯誤: ${classified.message}\n` +
      `Transcript 已儲存至 ${ctx.session.transcriptPath}。\n` +
      `你可以使用此 Transcript 在新會話中繼續工作。`,
    continueLoop: false,
  };
}

async function rebuildSession(session: Session): Promise<Session | null> {
  // 嘗試從最近的 Transcript 重建
  const transcripts = await transcriptStore.list(session.id);
  if (transcripts.length === 0) return null;
  
  const latest = transcripts[transcripts.length - 1];
  const entries = await transcriptStore.load(latest.path);
  
  // 用 Transcript 恢復訊息
  const messages = entries.map((e) => ({
    role: e.role,
    content: e.content,
    ...(e.toolName ? { toolName: e.toolName } : {}),
  }));
  
  // 壓縮恢復的訊息
  const compacted = await proactiveCompact(messages, session);
  
  return { ...session, messages: compacted };
}
```

---

## 4. 統一恢復入口

```typescript
async function classifyAndRecover(
  error: Error,
  ctx: RecoveryContext
): Promise<RecoveryResult> {
  // 步驟 1：分類
  const classified = classifyError(error);
  
  // 步驟 2：記錄
  console.log(
    `[恢復] 錯誤分類: ${classified.category} | ` +
    `嚴重度: ${classified.severity} | ` +
    `可恢復: ${classified.recoverable}`
  );
  
  // 步驟 3：根據嚴重度選擇恢復策略
  switch (classified.severity) {
    case "light":
      return lightRecover(classified, ctx);
    
    case "medium":
      return mediumRecover(classified, ctx);
    
    case "heavy":
      return heavyRecover(classified, ctx);
  }
}

interface RecoveryContext {
  session: Session;
  retryCount: number;
  continuationCount: number;
}

interface RecoveryResult {
  /** 恢復動作 */
  action: "inject_error" | "retry" | "terminate";
  
  /** 要注入的訊息（inject_error 或 terminate 時使用） */
  message: string | null;
  
  /** 是否繼續主迴圈 */
  continueLoop: boolean;
}
```

---

## 5. 主迴圈整合

```typescript
async function mainLoop(session: Session): Promise<void> {
  const recoveryCtx: RecoveryContext = {
    session,
    retryCount: 0,
    continuationCount: 0,
  };
  
  while (!session.done) {
    try {
      // drain 後台任務
      const completed = session.backgroundTasks.drain();
      for (const task of completed) {
        session.messages.push(buildTaskNotification(task));
      }
      
      // 微壓縮
      session.messages = microCompact(session.messages);
      
      // 呼叫 LLM
      const response = await llm.chat({
        system: assembleSystemPrompt(session.context),
        messages: session.messages,
      });
      
      // 重置重試計數
      recoveryCtx.retryCount = 0;
      
      // 處理回應
      session.messages.push(response);
      
      // 執行工具
      if (response.toolCalls) {
        const results = await executor.executeTools(response.toolCalls);
        session.messages.push(...results);
      }
      
    } catch (error) {
      // ▶ 統一恢復入口
      const result = await classifyAndRecover(error as Error, recoveryCtx);
      
      if (result.message) {
        session.messages.push({
          role: "system",
          content: result.message,
        });
      }
      
      if (!result.continueLoop) {
        session.done = true;
        break;
      }
      
      // retry 動作：回到迴圈頂端重試
    }
  }
}
```

---

## 6. 錯誤分類與恢復策略總表

| 錯誤分類 | 嚴重度 | 恢復策略 | 描述 |
|----------|--------|----------|------|
| tool_input_error | Light | 回傳錯誤給模型 | 模型修正參數後重試 |
| permission_denied | Light | 回傳錯誤給模型 | 模型換方式或請求授權 |
| hook_blocked | Light | 回傳錯誤給模型 | 模型調整操作方式 |
| prompt_too_long | Medium | 反應式壓縮 + 重試 | 自動壓縮後重試 LLM 呼叫 |
| max_output_tokens | Medium | 注入續寫提示（最多 3 次） | "Continue exactly where you left off" |
| model_api_error | Medium | 退避重試 | 指數退避 + 隨機抖動 |
| model_overloaded | Medium | 退避重試 | 最長等待 30 秒 |
| catastrophic | Heavy | 儲存 Transcript → 重建 → 終止 | 最後防線 |

---

## 驗收標準

- [ ] `classifyError` 正確分類所有八種錯誤類型
- [ ] Light 恢復：將錯誤訊息注入為工具結果
- [ ] Medium 恢復 — prompt_too_long：觸發反應式壓縮並重試
- [ ] Medium 恢復 — max_output_tokens：注入續寫提示，最多 3 次
- [ ] Medium 恢復 — model_overloaded：指數退避重試
- [ ] Heavy 恢復：緊急儲存 Transcript
- [ ] Heavy 恢復：嘗試從 Transcript 重建會話
- [ ] Heavy 恢復：重建失敗時安全終止
- [ ] `classifyAndRecover` 統一入口正確路由
- [ ] 主迴圈整合恢復管線，不因錯誤崩潰
- [ ] 單元測試覆蓋所有錯誤分類和恢復路徑

---

## 參考原始碼

| 檔案 | 說明 |
|------|------|
| `src/core/recovery/classify.ts` | 錯誤分類邏輯 |
| `src/core/recovery/light.ts` | Light 恢復策略 |
| `src/core/recovery/medium.ts` | Medium 恢復策略 |
| `src/core/recovery/heavy.ts` | Heavy 恢復策略 |
| `src/core/recovery/index.ts` | classifyAndRecover 統一入口 |
| `src/core/agent.ts` | 主迴圈恢復整合 |

---

## 產品經理視角總結

錯誤是決策點，而非終點。

大多數 Agent 框架把錯誤處理當作事後想法——「出錯了就拋異常」。但在真實的長時間工作場景中，錯誤不是異常，而是**常態**。API 會超時、模型會過載、使用者會拒絕權限、Hook 會阻斷操作。

三級恢復策略的設計哲學是**漸進式升級**：

- **Light**：大多數錯誤（輸入錯誤、權限拒絕）只需要告訴模型「你做錯了」，模型自己就能修正
- **Medium**：系統級錯誤（token 溢出、API 過載）需要 Harness 介入，但仍然可以自動恢復
- **Heavy**：真正的災難性錯誤才需要儲存現場和終止會話

`max_output_tokens` 的續寫機制值得特別注意——當模型的輸出被截斷時，注入 "Continue exactly where you left off" 可以讓模型無縫接續，使用者甚至不會察覺中斷。最多 3 次的限制則防止了無限續寫迴圈。

最後，即使是 catastrophic 錯誤，系統也會在終止前儲存 Transcript。這確保了**沒有工作被白白丟失**——使用者總是可以從 Transcript 中恢復。
