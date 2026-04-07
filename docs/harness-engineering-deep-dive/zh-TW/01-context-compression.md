# Phase 1 — 三層上下文壓縮需求文檔

> **狀態**: 設計完成  
> **優先級**: P0 — Wave 1 基礎層  
> **前置依賴**: 無  
> **後置被依賴**: Phase 3（全文持久化）、Phase 4（身份重注入）

---

## 1. 問題陳述

LLM 的上下文視窗是有限資源。一個典型的程式碼助手會話，100 輪對話可能產生 300K+ token，遠超大多數模型的視窗上限。即使模型支援 200K token，過長的上下文也會導致：

- **注意力稀釋**：模型對早期內容的關注度下降
- **延遲增加**：輸入 token 越多，首 token 延遲越高
- **成本攀升**：按 token 計費，冗長的工具輸出是浪費

---

## 2. 三層壓縮模型

```
               觸發條件              壓縮率        成本
┌────────────────────────────────────────────────────────┐
│  第一層：微壓縮（Micro-Compact）                         │
│  觸發：每次 LLM 呼叫前           40-60%        零成本    │
│  方式：裁剪已使用的工具結果                                │
├────────────────────────────────────────────────────────┤
│  第二層：主動壓縮（Proactive Compaction）                  │
│  觸發：token 達到 80% 閾值        ~80%          一次 LLM  │
│  方式：LLM 生成摘要替換原始對話                            │
├────────────────────────────────────────────────────────┤
│  第三層：反應式壓縮（Reactive Compaction）                  │
│  觸發：API 報 prompt_too_long     ~95%          一次 LLM  │
│  方式：激進微壓縮 + 主動壓縮 + 自動重試                    │
└────────────────────────────────────────────────────────┘
```

---

## 3. 第一層：微壓縮（Micro-Compact）

### 3.1 設計原理

大量 token 消耗來自工具結果。例如一次 `Grep` 可能回傳 500 行程式碼，但後續對話中模型已經處理過這些結果，不需要再看完整內容。微壓縮在每次 LLM 呼叫前，對已處理過的工具結果進行裁剪。

### 3.2 可壓縮工具與不可壓縮工具

```typescript
// 可壓縮：結果是一次性的，使用後可安全裁剪
const COMPRESSIBLE_TOOLS = [
  "bash",        // Shell 輸出通常很長
  "read",        // 檔案內容已被模型閱讀
  "grep",        // 搜尋結果已被模型處理
  "glob",        // 檔案清單已被模型使用
  "edit",        // 編輯確認訊息
  "write",       // 寫入確認訊息
  "webfetch",    // 網頁內容已被模型擷取
  "websearch",   // 搜尋結果已被模型閱讀
];

// 不可壓縮：結果具有持續參考價值
const INCOMPRESSIBLE_TOOLS = [
  "task",        // 子任務結果需要持續參考
  "question",    // 使用者回答不能丟失
  "skill",       // 技能結果可能被後續引用
  "memory",      // 記憶內容是長期知識
];
```

### 3.3 微壓縮偽代碼

```typescript
function microCompact(messages: Message[], keep_recent: number = 5): Message[] {
  const result = [...messages];
  
  for (let i = 0; i < result.length - keep_recent; i++) {
    const msg = result[i];
    if (msg.role !== "tool") continue;
    
    const toolName = msg.toolName;
    if (!COMPRESSIBLE_TOOLS.includes(toolName)) continue;
    
    // 已經壓縮過的跳過
    if (msg.content.startsWith("[已壓縮]")) continue;
    
    const originalLength = msg.content.length;
    result[i] = {
      ...msg,
      content: `[已壓縮] ${toolName} 結果（原始 ${originalLength} 字元）`,
    };
  }
  
  return result;
}
```

### 3.4 效果估算

| 場景 | 原始 token | 壓縮後 token | 壓縮率 |
|------|-----------|-------------|--------|
| 10 次 Grep（每次 500 行） | ~50,000 | ~20,000 | 60% |
| 5 次 Read（每次 200 行） | ~15,000 | ~7,500 | 50% |
| 混合工具呼叫 20 次 | ~80,000 | ~35,000 | 56% |

---

## 4. 第二層：主動壓縮（Proactive Compaction）

### 4.1 觸發條件

```typescript
const PROACTIVE_THRESHOLD = 0.80; // 80% 上下文視窗

function shouldProactiveCompact(
  currentTokens: number,
  maxTokens: number
): boolean {
  return currentTokens >= maxTokens * PROACTIVE_THRESHOLD;
}
```

### 4.2 壓縮流程

```typescript
async function proactiveCompact(
  messages: Message[],
  session: Session
): Promise<Message[]> {
  // 步驟 1：儲存完整對話到 Transcript（Phase 3）
  await transcriptStore.save(session.id, messages);
  
  // 步驟 2：呼叫 LLM 生成摘要
  const summary = await llm.summarize({
    system: "你是一個對話摘要助手。請保留所有關鍵決策、程式碼變更、" +
            "未完成的任務和重要的使用者偏好。移除冗餘的工具輸出和中間步驟。",
    messages: messages,
  });
  
  // 步驟 3：用摘要替換原始對話
  const compactedMessages: Message[] = [
    {
      role: "assistant",
      content: `[對話摘要]\n${summary}\n[/對話摘要]`,
    },
  ];
  
  // 步驟 4：注入身份資訊（Phase 4）
  const identity = buildIdentityBlock(session);
  compactedMessages.unshift({
    role: "system",
    content: identity,
  });
  
  return compactedMessages;
}
```

---

## 5. 第三層：反應式壓縮（Reactive Compaction）

### 5.1 觸發條件

當 LLM API 回傳 `prompt_too_long` 錯誤或 token 數超過 95% 閾值時觸發。

### 5.2 壓縮流程

```typescript
async function reactiveCompact(
  messages: Message[],
  session: Session,
  error: APIError
): Promise<Message[]> {
  // 步驟 1：激進微壓縮（只保留最近 2 條）
  let compacted = microCompact(messages, /* keep_recent */ 2);
  
  // 步驟 2：如果仍然超出，執行主動壓縮
  const tokenCount = countTokens(compacted);
  if (tokenCount > session.maxTokens * 0.95) {
    compacted = await proactiveCompact(compacted, session);
  }
  
  // 步驟 3：自動重試原始請求
  return compacted;
}
```

---

## 6. Token 預算管理

### 6.1 零值保護

```typescript
function calculateMaxInput(rawMaxInput: number): number {
  // 零值保護：避免負數閾值導致無限壓縮迴圈
  return Math.max(rawMaxInput, 0);
}

function getCompressionThreshold(maxInput: number): number {
  const threshold = maxInput * PROACTIVE_THRESHOLD;
  // 確保閾值至少為 1000 token，避免頻繁壓縮
  return Math.max(threshold, 1000);
}
```

### 6.2 預算分配

```
總上下文視窗 = maxInput
├── 系統提示詞（靜態）   ~5-10%
├── 系統提示詞（動態）   ~5-15%
├── 對話歷史             ~60-80%
├── 工具結果             ~10-20%（壓縮前可能更高）
└── 安全邊際             ~5%
```

---

## 7. 整合流程圖

```
使用者輸入
    │
    ▼
微壓縮（每次 LLM 呼叫前）
    │
    ▼
檢查 token 數
    │
    ├─ < 80% ──→ 正常呼叫 LLM
    │
    ├─ ≥ 80% ──→ 儲存 Transcript → 主動壓縮 → 注入身份 → 呼叫 LLM
    │
    └─ API 報錯 ──→ 激進微壓縮 → 主動壓縮 → 自動重試
```

---

## 驗收標準

- [ ] 微壓縮在每次 LLM 呼叫前自動執行
- [ ] 可壓縮/不可壓縮工具清單可設定
- [ ] 主動壓縮在 80% 閾值時觸發（閾值可設定）
- [ ] 主動壓縮前自動儲存完整 Transcript
- [ ] 主動壓縮後自動注入身份區塊
- [ ] 反應式壓縮能處理 `prompt_too_long` 錯誤
- [ ] 反應式壓縮後自動重試原始請求
- [ ] `maxInput` 零值保護生效，不產生負數閾值
- [ ] 壓縮率可量測，微壓縮達到 40-60%
- [ ] 單元測試覆蓋三層壓縮的邊界情況

---

## 參考原始碼

| 檔案 | 說明 |
|------|------|
| `src/core/compaction/micro-compact.ts` | 微壓縮實作 |
| `src/core/compaction/proactive.ts` | 主動壓縮實作 |
| `src/core/compaction/reactive.ts` | 反應式壓縮實作 |
| `src/core/compaction/token-budget.ts` | Token 預算計算 |
| `src/core/compaction/index.ts` | 壓縮管線入口 |

---

## 產品經理視角總結

三層上下文壓縮就像作業系統管理記憶體一樣管理 token。

- **微壓縮**是垃圾回收——自動、零成本、持續運行
- **主動壓縮**是記憶體分頁——在壓力來臨前主動釋放空間
- **反應式壓縮**是 OOM Killer——最後的防線，確保系統不崩潰

沒有這套機制，Agent 要麼在長對話中品質急劇下降，要麼直接因為 token 溢出而崩潰。壓縮不是可選的最佳化——它是長時間工作的 Agent 的**生存必需品**。
