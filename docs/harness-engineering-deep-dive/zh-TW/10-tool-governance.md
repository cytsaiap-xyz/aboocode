# Phase 10 — 工具治理管線需求文檔

> **狀態**: 設計完成  
> **優先級**: P1 — Wave 3 持久化與治理  
> **前置依賴**: Phase 6（流式執行器）、Phase 7（Hook 系統）  
> **後置被依賴**: Phase 11（驗證 Agent）

---

## 1. 問題陳述

在沒有治理管線的系統中，工具呼叫是一個黑盒：

```
模型請求 → 工具執行 → 結果回傳
```

這意味著：
- **無校驗**：不正確的輸入直接傳給工具
- **無權限**：任何工具隨時可呼叫
- **無可觀測性**：不知道工具做了什麼、花了多久、是否成功
- **無擴展**：無法在執行前後插入自訂邏輯

**目標**：將工具呼叫從「可呼叫」升級到「可治理」。

---

## 2. 八步執行鏈

```
┌──────────────────────────────────────────────────────────────┐
│                    工具治理管線（8 步）                         │
│                                                              │
│  ① findTool                                                  │
│  │  在工具註冊表中查詢工具定義                                  │
│  ▼                                                           │
│  ② validateInput (Zod)                                       │
│  │  使用 Zod Schema 校驗輸入參數                               │
│  ▼                                                           │
│  ③ runCustomValidators                                       │
│  │  執行自訂校驗器（路徑安全、注入偵測等）                      │
│  ▼                                                           │
│  ④ firePreHooks                                              │
│  │  觸發 tool.execute.before Hook（可阻斷）                    │
│  ▼                                                           │
│  ⑤ resolvePermission                                         │
│  │  檢查權限（自動授權 / 使用者確認 / 拒絕）                   │
│  ▼                                                           │
│  ⑥ executeTool                                               │
│  │  實際執行工具邏輯                                           │
│  ▼                                                           │
│  ⑦ recordTelemetry                                           │
│  │  記錄遙測資料（耗時、成功/失敗、輸入/輸出摘要）              │
│  ▼                                                           │
│  ⑧ firePostHooks → formatResult                             │
│     觸發 tool.execute.after Hook → 格式化回傳結果              │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. 各步驟詳解

### 3.1 步驟 ①：findTool

```typescript
function findTool(
  name: string,
  registry: ToolRegistry
): ToolDefinition | null {
  // 先查立即載入的工具
  const immediate = registry.getImmediate(name);
  if (immediate) return immediate;
  
  // 再查已啟動的延遲工具
  const deferred = registry.getActivatedDeferred(name);
  if (deferred) return deferred;
  
  return null; // 工具不存在
}
```

### 3.2 步驟 ②：validateInput (Zod)

```typescript
function validateInput(
  tool: ToolDefinition,
  input: Record<string, unknown>
): ValidationResult {
  try {
    const parsed = tool.schema.parse(input);
    return { valid: true, parsed };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        valid: false,
        errors: error.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      };
    }
    throw error;
  }
}

interface ValidationResult {
  valid: boolean;
  parsed?: Record<string, unknown>;
  errors?: Array<{ path: string; message: string }>;
}
```

### 3.3 步驟 ③：runCustomValidators

自訂校驗器處理 Zod 無法表達的業務規則：

```typescript
interface CustomValidator {
  id: string;
  toolNames: string[]; // 適用的工具名稱，"*" 表示所有
  validate: (
    input: Record<string, unknown>,
    ctx: ToolContext
  ) => Promise<ValidatorResult>;
}

// 路徑安全校驗器
const pathSafetyValidator: CustomValidator = {
  id: "path-safety",
  toolNames: ["read", "write", "edit", "bash"],
  validate: async (input, ctx) => {
    const paths = extractPaths(input);
    for (const p of paths) {
      // 不允許存取工作目錄之外的路徑
      if (!p.startsWith(ctx.cwd) && !p.startsWith("/tmp/")) {
        return {
          valid: false,
          reason: `路徑 ${p} 不在允許的範圍內（工作目錄: ${ctx.cwd}）`,
        };
      }
    }
    return { valid: true };
  },
};

// 命令注入偵測器
const injectionDetector: CustomValidator = {
  id: "injection-detect",
  toolNames: ["bash"],
  validate: async (input) => {
    const cmd = input.command as string;
    const suspiciousPatterns = [
      /;\s*curl\s+/,           // 分號注入 curl
      /\|\s*bash/,             // 管道到 bash
      /`.*`/,                  // 反引號執行
      /\$\(.*\)/,             // 命令替換（需要仔細判斷）
    ];
    
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(cmd)) {
        return {
          valid: false,
          reason: `偵測到可疑的命令模式: ${pattern.toString()}`,
        };
      }
    }
    return { valid: true };
  },
};
```

### 3.4 步驟 ④：firePreHooks

```typescript
async function firePreHooks(
  toolName: string,
  input: Record<string, unknown>,
  ctx: HookContext
): Promise<{ blocked: boolean; reason?: string; input: Record<string, unknown> }> {
  const result = await hookRunner.fire("tool.execute.before", {
    toolName,
    input,
    context: ctx,
  });
  
  if (result.blocked) {
    return { blocked: true, reason: result.reason, input };
  }
  
  // Hook 可能修改了輸入
  const modifiedInput = result.modified?.input ?? input;
  return { blocked: false, input: modifiedInput as Record<string, unknown> };
}
```

### 3.5 步驟 ⑤：resolvePermission

```typescript
async function resolvePermission(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<PermissionDecision> {
  // 檢查 Hook 系統
  const hookResult = await hookRunner.fire("tool.permission.check", {
    toolName,
    input,
    currentPermission: "pending",
    context: ctx,
  });
  
  if (hookResult.blocked) {
    return { granted: false, reason: hookResult.reason };
  }
  
  // 檢查自動授權規則
  if (isAutoApproved(toolName, input, ctx)) {
    return { granted: true };
  }
  
  // 需要使用者確認
  const userDecision = await ctx.askPermission(toolName, input);
  return userDecision;
}

interface PermissionDecision {
  granted: boolean;
  reason?: string;
}
```

### 3.6 步驟 ⑥：executeTool

```typescript
async function executeTool(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const startTime = Date.now();
  
  try {
    const result = await tool.execute(input, ctx);
    return {
      success: true,
      output: result,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: String(error),
      durationMs: Date.now() - startTime,
    };
  }
}
```

### 3.7 步驟 ⑦：recordTelemetry

```typescript
interface TelemetryRecord {
  timestamp: string;
  toolName: string;
  inputSummary: string;   // 輸入摘要（不含敏感資料）
  success: boolean;
  durationMs: number;
  outputSize: number;      // 輸出大小（字元數）
  errorType?: string;
  sessionId: string;
  turnIndex: number;
}

class TelemetryBuffer {
  private buffer: TelemetryRecord[] = [];
  private static FLUSH_THRESHOLD = 50;
  
  record(entry: TelemetryRecord): void {
    this.buffer.push(entry);
    if (this.buffer.length >= TelemetryBuffer.FLUSH_THRESHOLD) {
      this.flush();
    }
  }
  
  flush(): void {
    if (this.buffer.length === 0) return;
    
    const records = [...this.buffer];
    this.buffer = [];
    
    // 寫入遙測檔案（非同步，不阻塞主流程）
    writeTelemetryAsync(records).catch((err) => {
      console.error("遙測記錄失敗:", err);
    });
  }
}
```

### 3.8 步驟 ⑧：firePostHooks + formatResult

```typescript
async function firePostHooks(
  toolName: string,
  input: Record<string, unknown>,
  output: ToolResult,
  durationMs: number,
  ctx: HookContext
): Promise<ToolResult> {
  const result = await hookRunner.fire("tool.execute.after", {
    toolName,
    input,
    output,
    durationMs,
    context: ctx,
  });
  
  // Post Hook 可以修改輸出但不能阻斷
  if (result.modified?.output) {
    return result.modified.output as ToolResult;
  }
  return output;
}

function formatResult(result: ToolResult): string {
  if (result.success) {
    return typeof result.output === "string"
      ? result.output
      : JSON.stringify(result.output, null, 2);
  }
  return `工具執行失敗: ${result.error}`;
}
```

---

## 4. wrapExecute 透明包裝

```typescript
function wrapExecute(
  tool: ToolDefinition,
  pipeline: GovernancePipeline
): ToolDefinition {
  return {
    ...tool,
    execute: async (input, ctx) => {
      return pipeline.run(tool, input, ctx);
    },
  };
}

class GovernancePipeline {
  async run(
    tool: ToolDefinition,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<string> {
    // ① findTool（已完成，tool 參數就是結果）
    
    // ② validateInput
    const validation = validateInput(tool, input);
    if (!validation.valid) {
      return `輸入校驗失敗: ${JSON.stringify(validation.errors)}`;
    }
    
    // ③ runCustomValidators
    for (const validator of this.validators) {
      if (validator.toolNames.includes("*") || validator.toolNames.includes(tool.name)) {
        const result = await validator.validate(validation.parsed!, ctx);
        if (!result.valid) {
          return `校驗失敗 [${validator.id}]: ${result.reason}`;
        }
      }
    }
    
    // ④ firePreHooks
    const preResult = await firePreHooks(tool.name, validation.parsed!, ctx);
    if (preResult.blocked) {
      return `被 Hook 阻斷: ${preResult.reason}`;
    }
    
    // ⑤ resolvePermission
    const permission = await resolvePermission(tool.name, preResult.input, ctx);
    if (!permission.granted) {
      return `權限拒絕: ${permission.reason}`;
    }
    
    // ⑥ executeTool
    const result = await executeTool(tool, preResult.input, ctx);
    
    // ⑦ recordTelemetry
    this.telemetry.record({
      timestamp: new Date().toISOString(),
      toolName: tool.name,
      inputSummary: summarizeInput(preResult.input),
      success: result.success,
      durationMs: result.durationMs,
      outputSize: JSON.stringify(result.output ?? result.error).length,
      errorType: result.success ? undefined : classifyError(result.error!),
      sessionId: ctx.sessionId,
      turnIndex: ctx.turnIndex,
    });
    
    // ⑧ firePostHooks + formatResult
    const postResult = await firePostHooks(
      tool.name, preResult.input, result, result.durationMs, ctx
    );
    return formatResult(postResult);
  }
}
```

---

## 驗收標準

- [ ] 八步管線完整實作且按順序執行
- [ ] Zod 校驗失敗時回傳清晰的錯誤訊息
- [ ] 自訂校驗器（路徑安全、注入偵測）正確攔截
- [ ] PreHook 阻斷時工具不執行
- [ ] 權限拒絕時工具不執行
- [ ] 遙測記錄包含 toolName、durationMs、success
- [ ] 遙測緩衝區每 50 條自動刷新
- [ ] PostHook 可修改輸出但不能阻斷
- [ ] `wrapExecute` 對工具定義透明（不改變工具介面）
- [ ] 管線中任何步驟失敗都有清晰的錯誤回傳
- [ ] 單元測試覆蓋八步管線的正常和異常路徑

---

## 參考原始碼

| 檔案 | 說明 |
|------|------|
| `src/core/governance/pipeline.ts` | GovernancePipeline 主管線 |
| `src/core/governance/validators.ts` | 自訂校驗器 |
| `src/core/governance/permission.ts` | 權限解析 |
| `src/core/governance/telemetry.ts` | 遙測記錄與緩衝區 |
| `src/core/governance/wrap.ts` | wrapExecute 透明包裝 |

---

## 產品經理視角總結

工具治理管線將工具呼叫從「可呼叫」升級到「可治理」。

八步管線的設計哲學是**分離關注點**：校驗、權限、執行、記錄各自獨立，透過管線串聯。這意味著新增一種校驗規則不需要修改執行邏輯，新增一種遙測目標不需要修改權限邏輯。

`wrapExecute` 的透明包裝確保工具本身不需要知道治理管線的存在——所有治理邏輯都在工具外面，工具只關心自己的核心功能。這是「開放/封閉原則」在 Agent 系統中的直接體現。

對於企業使用者來說，這條管線提供了三個關鍵能力：**可審計**（遙測記錄所有操作）、**可控制**（權限和 Hook 限制操作）、**可擴展**（自訂校驗器和 Hook 加入新規則）。
