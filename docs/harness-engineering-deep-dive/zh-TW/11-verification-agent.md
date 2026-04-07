# Phase 11 — 獨立驗證 Agent 需求文檔

> **狀態**: 設計完成  
> **優先級**: P2 — Wave 5 頂層  
> **前置依賴**: Phase 9（後台 Agent）、Phase 10（工具治理）、Phase 12（工作區隔離）  
> **後置被依賴**: 無

---

## 1. 問題陳述

LLM 有一個根本的認知偏差：**它傾向於認為自己的輸出是正確的**。當你讓同一個模型生成程式碼然後驗證程式碼時，驗證幾乎總是通過——因為模型不會挑戰自己的決策。

這不是模型的 Bug，而是自回歸模型的結構性限制：生成和驗證使用相同的權重，自然傾向一致。

**核心原則**：驗證者不是實作者。

---

## 2. Verify Agent 設計

### 2.1 角色定義

```typescript
interface VerifyAgentConfig {
  /** Agent 名稱 */
  name: "verify-agent";
  
  /** 執行模式 */
  mode: "subagent";
  
  /** 工作區模式（唯讀） */
  workspaceMode: "readonly";
  
  /** 可用工具白名單 */
  allowedTools: string[];
  
  /** 禁止工具黑名單 */
  blockedTools: string[];
}

const VERIFY_AGENT_CONFIG: VerifyAgentConfig = {
  name: "verify-agent",
  mode: "subagent",
  workspaceMode: "readonly",
  
  // 只允許唯讀和執行工具
  allowedTools: [
    "read",          // 閱讀檔案
    "grep",          // 搜尋內容
    "glob",          // 搜尋檔案
    "bash",          // 執行命令（唯讀命令如 test、lint）
    "codesearch",    // 程式碼搜尋
    "toolsearch",    // 工具搜尋
  ],
  
  // 明確禁止修改工具
  blockedTools: [
    "write",         // 不能寫入檔案
    "edit",          // 不能編輯檔案
    "apply_patch",   // 不能套用修補
    "memory-write",  // 不能修改記憶
    "task",          // 不能建立子任務
  ],
};
```

### 2.2 唯讀保護

驗證 Agent 的 `bash` 工具受到額外限制：

```typescript
const verifyBashValidator: CustomValidator = {
  id: "verify-bash-readonly",
  toolNames: ["bash"],
  validate: async (input, ctx) => {
    if (ctx.agentType !== "verify") return { valid: true };
    
    const cmd = input.command as string;
    
    // 允許的唯讀命令模式
    const allowedPatterns = [
      /^(npm|bun|yarn|pnpm)\s+(test|lint|typecheck|check)/,
      /^(cat|head|tail|wc|ls|find|grep|rg|git\s+(status|log|diff|show))/,
      /^(tsc\s+--noEmit|eslint\s+--no-fix)/,
    ];
    
    // 明確禁止的寫入模式
    const blockedPatterns = [
      /\b(rm|mv|cp|mkdir|touch|chmod|chown)\b/,
      /\b(git\s+(add|commit|push|merge|rebase|reset|checkout))\b/,
      />/,  // 重導向（寫入）
    ];
    
    for (const pattern of blockedPatterns) {
      if (pattern.test(cmd)) {
        return {
          valid: false,
          reason: `驗證 Agent 不允許執行修改命令: ${cmd}`,
        };
      }
    }
    
    return { valid: true };
  },
};
```

---

## 3. VerifyTool

主 Agent 透過 `VerifyTool` 啟動驗證 Agent：

```typescript
const VerifyTool = defineTool({
  name: "verify",
  description: "啟動獨立驗證 Agent，對指定的程式碼或操作進行唯讀驗證。",
  parameters: z.object({
    description: z.string().describe("驗證任務描述"),
    checks: z.array(z.object({
      name: z.string().describe("檢查項名稱"),
      command: z.string().optional().describe("要執行的命令（如 npm test）"),
      expectation: z.string().describe("預期結果"),
    })).describe("驗證檢查清單"),
    files: z.array(z.string()).optional().describe("需要檢查的檔案清單"),
  }),
  
  execute: async (params, ctx) => {
    // 建立驗證 Agent
    const verifyAgent = await createSubAgent({
      config: VERIFY_AGENT_CONFIG,
      prompt: buildVerifyPrompt(params),
      workspaceMode: "readonly",
      parentSessionId: ctx.sessionId,
    });
    
    // 執行驗證
    const result = await verifyAgent.run();
    
    // 解析結構化報告
    return parseVerifyReport(result);
  },
});

function buildVerifyPrompt(params: VerifyParams): string {
  let prompt = `你是一個獨立驗證 Agent。你的任務是驗證以下項目：\n\n`;
  prompt += `描述: ${params.description}\n\n`;
  prompt += `檢查清單:\n`;
  
  for (const check of params.checks) {
    prompt += `- ${check.name}`;
    if (check.command) prompt += ` (命令: ${check.command})`;
    prompt += `\n  預期: ${check.expectation}\n`;
  }
  
  if (params.files) {
    prompt += `\n需要檢查的檔案:\n`;
    for (const file of params.files) {
      prompt += `- ${file}\n`;
    }
  }
  
  prompt += `\n請對每個檢查項執行驗證，並回傳結構化報告。`;
  prompt += `\n重要：你是唯讀 Agent，不能修改任何檔案。只能閱讀和執行測試命令。`;
  
  return prompt;
}
```

---

## 4. 結構化報告

### 4.1 報告格式

```typescript
interface VerifyReport {
  /** 總體結果 */
  overall: "PASS" | "FAIL" | "PARTIAL";
  
  /** 各檢查項結果 */
  checks: VerifyCheckResult[];
  
  /** 摘要 */
  summary: string;
  
  /** 驗證耗時 */
  durationMs: number;
}

interface VerifyCheckResult {
  /** 檢查項名稱 */
  name: string;
  
  /** 結果 */
  status: "PASS" | "FAIL";
  
  /** 原因說明 */
  reason: string;
  
  /** 命令輸出（如果有） */
  evidence?: string;
  
  /** 相關檔案和行號 */
  locations?: Array<{
    file: string;
    line?: number;
    snippet?: string;
  }>;
}
```

### 4.2 報告解析

```typescript
function parseVerifyReport(agentOutput: string): VerifyReport {
  // 嘗試從 Agent 輸出中解析結構化報告
  // Agent 被指示以 JSON 格式回傳
  
  try {
    // 搜尋 JSON 區塊
    const jsonMatch = agentOutput.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]) as VerifyReport;
    }
  } catch {
    // JSON 解析失敗，退回文字報告
  }
  
  // 退回方案：文字分析
  return {
    overall: agentOutput.includes("FAIL") ? "FAIL" : 
             agentOutput.includes("PARTIAL") ? "PARTIAL" : "PASS",
    checks: [],
    summary: agentOutput,
    durationMs: 0,
  };
}
```

### 4.3 報告範例

```json
{
  "overall": "PARTIAL",
  "checks": [
    {
      "name": "型別檢查",
      "status": "PASS",
      "reason": "tsc --noEmit 通過，無型別錯誤",
      "evidence": "$ tsc --noEmit\n(無輸出，退出碼 0)"
    },
    {
      "name": "單元測試",
      "status": "PASS",
      "reason": "所有 42 個測試通過",
      "evidence": "$ npm test\nTest Suites: 8 passed\nTests: 42 passed"
    },
    {
      "name": "新增函式有文檔註解",
      "status": "FAIL",
      "reason": "formatResult 函式缺少 JSDoc 註解",
      "locations": [
        {
          "file": "src/core/governance/pipeline.ts",
          "line": 127,
          "snippet": "function formatResult(result: ToolResult): string {"
        }
      ]
    }
  ],
  "summary": "2/3 檢查通過。formatResult 函式需要補充 JSDoc 文檔註解。",
  "durationMs": 12500
}
```

---

## 5. 使用場景

### 5.1 程式碼修改後驗證

```
主 Agent:
  1. edit("src/utils.ts", ...)
  2. edit("src/types.ts", ...)
  3. verify({
       description: "驗證重構後的工具模組",
       checks: [
         { name: "型別檢查", command: "tsc --noEmit", expectation: "無型別錯誤" },
         { name: "單元測試", command: "npm test", expectation: "所有測試通過" },
         { name: "Lint", command: "npm run lint", expectation: "無 Lint 錯誤" },
       ],
       files: ["src/utils.ts", "src/types.ts"]
     })
```

### 5.2 後台驗證

搭配 Phase 9 的後台 Agent，可以在修改的同時啟動後台驗證：

```
主 Agent:
  1. task("後台驗證", run_in_background: true, prompt: "verify ...")
  2. 繼續修改其他檔案...
  3. [drain 時收到驗證結果]
```

---

## 6. 與其他 Phase 的整合

| Phase | 整合方式 |
|-------|----------|
| Phase 9（後台 Agent） | 驗證可作為後台任務運行 |
| Phase 10（工具治理） | 驗證 Agent 的工具受治理管線約束 |
| Phase 12（工作區隔離） | 驗證 Agent 使用 readonly 工作區 |

---

## 驗收標準

- [ ] 驗證 Agent 使用 readonly 工作區模式
- [ ] 驗證 Agent 不能使用 write、edit、apply_patch 工具
- [ ] 驗證 Agent 的 bash 命令受唯讀校驗器限制
- [ ] VerifyTool 接受 description 和 checks 陣列
- [ ] 報告格式包含 overall（PASS/FAIL/PARTIAL）
- [ ] 報告每個 check 包含 status、reason 和 evidence
- [ ] 報告包含 locations（檔案和行號）
- [ ] 可與後台 Agent 整合（非阻塞驗證）
- [ ] 驗證 Agent 失敗不影響主 Agent
- [ ] 單元測試覆蓋報告解析和工具限制

---

## 參考原始碼

| 檔案 | 說明 |
|------|------|
| `src/tools/verify.ts` | VerifyTool 實作 |
| `src/core/agents/verify-agent.ts` | 驗證 Agent 設定與建立 |
| `src/core/agents/verify-report.ts` | 報告型別與解析 |
| `src/core/governance/validators.ts` | 唯讀 bash 校驗器 |

---

## 產品經理視角總結

自我驗證不可靠，需要獨立的唯讀驗證角色。

這個設計借鑒了軟體工程中的一個基本原則：**寫程式碼的人不應該是唯一測試程式碼的人**。Code Review 存在的原因就是因為作者有盲點。

驗證 Agent 的關鍵設計是**唯讀約束**。如果驗證者可以修改檔案，它就不是真正的驗證者——它會忍不住「順手修一下」，這就把驗證變成了又一輪實作。唯讀約束確保驗證 Agent 只能**觀察和報告**，不能行動。

結構化報告（PASS/FAIL/PARTIAL + 證據）讓主 Agent 能夠程式化地處理驗證結果，而不是靠解析自然語言。這是從「人工檢查」到「自動化驗證」的關鍵一步。
