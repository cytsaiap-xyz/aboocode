# Phase 7 — 增強 Hook 系統需求文檔

> **狀態**: 設計完成  
> **優先級**: P1 — Wave 2 核心能力  
> **前置依賴**: 無  
> **後置被依賴**: Phase 10（工具治理管線）

---

## 1. 問題陳述

沒有 Hook 系統，Aboocode 就是一個封閉的黑盒：

- 無法在工具執行前攔截危險操作
- 無法在會話開始/結束時執行自訂邏輯
- 無法修改工具的輸入或輸出
- 無法整合外部系統（日誌、通知、審計等）

Plugin 開發者需要一種標準化的方式來擴展 Agent 的行為，而不是修改核心程式碼。

---

## 2. 七種 Hook 類型

### 2.1 工具相關 Hook

```typescript
interface ToolHooks {
  /** 工具執行前觸發，可修改輸入或阻斷執行 */
  "tool.execute.before": {
    toolName: string;
    input: Record<string, unknown>;
    context: HookContext;
  };
  
  /** 工具執行後觸發，可修改輸出 */
  "tool.execute.after": {
    toolName: string;
    input: Record<string, unknown>;
    output: ToolResult;
    durationMs: number;
    context: HookContext;
  };
  
  /** 工具權限檢查時觸發，可授予或拒絕權限 */
  "tool.permission.check": {
    toolName: string;
    input: Record<string, unknown>;
    currentPermission: PermissionState;
    context: HookContext;
  };
}
```

### 2.2 會話相關 Hook

```typescript
interface SessionHooks {
  /** 會話開始時觸發 */
  "session.start": {
    sessionId: string;
    cwd: string;
    config: SessionConfig;
    context: HookContext;
  };
  
  /** 會話結束時觸發 */
  "session.end": {
    sessionId: string;
    cwd: string;
    turnCount: number;
    totalTokens: number;
    context: HookContext;
  };
}
```

### 2.3 互動相關 Hook

```typescript
interface InteractionHooks {
  /** 使用者提交提示詞時觸發，可修改提示詞或阻斷 */
  "prompt.submit": {
    prompt: string;
    context: HookContext;
  };
  
  /** 回合結束時觸發 */
  "turn.stop": {
    turnIndex: number;
    assistantMessage: string;
    toolCalls: ToolCall[];
    context: HookContext;
  };
}
```

---

## 3. Hook 資料結構

```typescript
interface HookHandler {
  /** 唯一識別碼 */
  id: string;
  
  /** 監聽的事件類型 */
  event: HookEvent;
  
  /** 優先級（數字越小越先執行） */
  priority: number;
  
  /** 處理函式 */
  handler: (payload: HookPayload) => Promise<HookResult>;
  
  /** 來源插件 */
  pluginId?: string;
}

type HookEvent =
  | "tool.execute.before"
  | "tool.execute.after"
  | "tool.permission.check"
  | "session.start"
  | "session.end"
  | "prompt.submit"
  | "turn.stop";

interface HookResult {
  /** 是否阻斷（僅 before/check 類 Hook 有效） */
  blocked?: boolean;
  
  /** 阻斷原因（blocked 為 true 時必填） */
  reason?: string;
  
  /** 修改後的資料（如修改輸入、輸出等） */
  modified?: Record<string, unknown>;
}

interface HookContext {
  sessionId: string;
  cwd: string;
  agentType: string;
  turnIndex: number;
}
```

---

## 4. 執行語義

### 4.1 串行執行

同一事件的多個 Hook 按 `priority` 排序後**串行執行**（不是並行）。理由：

- 前一個 Hook 的修改結果需要傳遞給下一個
- 阻斷語義需要短路（一個 Hook 阻斷後不再執行後續）

```typescript
class HookRunner {
  private handlers: Map<HookEvent, HookHandler[]> = new Map();
  
  async fire(event: HookEvent, payload: HookPayload): Promise<HookResult> {
    const handlers = this.handlers.get(event) ?? [];
    
    // 按優先級排序
    const sorted = [...handlers].sort((a, b) => a.priority - b.priority);
    
    let currentPayload = { ...payload };
    
    for (const handler of sorted) {
      const result = await handler.handler(currentPayload);
      
      // 阻斷語義：立即停止
      if (result.blocked) {
        return {
          blocked: true,
          reason: result.reason ?? `被 Hook ${handler.id} 阻斷`,
        };
      }
      
      // 修改語義：將修改應用到 payload
      if (result.modified) {
        currentPayload = { ...currentPayload, ...result.modified };
      }
    }
    
    return { blocked: false, modified: currentPayload };
  }
  
  register(handler: HookHandler): void {
    const existing = this.handlers.get(handler.event) ?? [];
    existing.push(handler);
    this.handlers.set(handler.event, existing);
  }
  
  unregister(handlerId: string): void {
    for (const [event, handlers] of this.handlers) {
      this.handlers.set(
        event,
        handlers.filter((h) => h.id !== handlerId)
      );
    }
  }
}
```

### 4.2 阻斷語義

阻斷僅對 `before` 和 `check` 類 Hook 有效：

| Hook | 阻斷效果 |
|------|----------|
| `tool.execute.before` | 工具不執行，回傳錯誤訊息給模型 |
| `tool.permission.check` | 權限拒絕 |
| `prompt.submit` | 提示詞不提交，回傳錯誤給使用者 |
| `tool.execute.after` | **不支援阻斷**（已執行完畢） |
| `session.start` | 會話不啟動 |
| `session.end` | **不支援阻斷**（已結束） |
| `turn.stop` | **不支援阻斷**（已結束） |

### 4.3 修改語義

修改允許 Hook 改變傳遞給下一步的資料：

```typescript
// 修改工具輸入的範例
const sanitizePathHook: HookHandler = {
  id: "sanitize-path",
  event: "tool.execute.before",
  priority: 10,
  handler: async (payload) => {
    if (payload.toolName === "bash") {
      const cmd = payload.input.command as string;
      // 把相對路徑轉為絕對路徑
      const sanitized = resolveAbsolutePath(cmd, payload.context.cwd);
      return {
        modified: { input: { ...payload.input, command: sanitized } },
      };
    }
    return {};
  },
};
```

---

## 5. 插件註冊範例

### 5.1 阻止危險的 rm 命令

```typescript
// plugins/safety-guard/index.ts
export default function safetyGuardPlugin(hooks: HookRunner): void {
  hooks.register({
    id: "block-rm-rf",
    event: "tool.execute.before",
    priority: 0, // 最高優先級
    handler: async (payload) => {
      if (payload.toolName !== "bash") return {};
      
      const command = payload.input.command as string;
      
      // 偵測危險的 rm 命令
      const dangerousPatterns = [
        /rm\s+-rf\s+\//,           // rm -rf /
        /rm\s+-rf\s+~\//,          // rm -rf ~/
        /rm\s+-rf\s+\.\./,         // rm -rf ../
        /rm\s+-rf\s+\*/,           // rm -rf *
      ];
      
      for (const pattern of dangerousPatterns) {
        if (pattern.test(command)) {
          return {
            blocked: true,
            reason: `安全防護：偵測到危險的刪除命令「${command}」。` +
                    `如果你確定要執行，請使用更精確的路徑。`,
          };
        }
      }
      
      return {};
    },
  });
}
```

### 5.2 會話統計記錄

```typescript
// plugins/session-stats/index.ts
export default function sessionStatsPlugin(hooks: HookRunner): void {
  hooks.register({
    id: "session-stats-start",
    event: "session.start",
    priority: 100,
    handler: async (payload) => {
      console.log(`[統計] 會話開始: ${payload.sessionId}`);
      return {};
    },
  });
  
  hooks.register({
    id: "session-stats-end",
    event: "session.end",
    priority: 100,
    handler: async (payload) => {
      console.log(
        `[統計] 會話結束: ${payload.sessionId}, ` +
        `${payload.turnCount} 輪, ${payload.totalTokens} token`
      );
      return {};
    },
  });
}
```

### 5.3 提示詞內容過濾

```typescript
// plugins/prompt-filter/index.ts
export default function promptFilterPlugin(hooks: HookRunner): void {
  hooks.register({
    id: "prompt-length-check",
    event: "prompt.submit",
    priority: 5,
    handler: async (payload) => {
      if (payload.prompt.length > 50000) {
        return {
          blocked: true,
          reason: "提示詞過長（超過 50,000 字元）。請縮短你的輸入。",
        };
      }
      return {};
    },
  });
}
```

---

## 6. Hook 與工具治理管線的整合

Hook 是工具治理管線（Phase 10）的一部分：

```
findTool → validateInput → runCustomValidators → ▶ firePreHooks ◀ →
resolvePermission → executeTool → recordTelemetry → ▶ firePostHooks ◀ →
formatResult
```

---

## 驗收標準

- [ ] 支援七種 Hook 類型
- [ ] Hook 按 `priority` 串行執行
- [ ] 阻斷語義：`blocked: true` 時短路後續 Hook 並阻止操作
- [ ] 修改語義：`modified` 資料傳遞到下一個 Hook
- [ ] `after` 和 `end` 類 Hook 不支援阻斷
- [ ] 插件可透過 `register` 方法註冊 Hook
- [ ] `unregister` 可移除指定 Hook
- [ ] Hook 執行失敗時不影響主流程（錯誤被捕獲並記錄）
- [ ] 單元測試覆蓋阻斷和修改語義
- [ ] 範例插件（安全防護、統計記錄）可正常運作

---

## 參考原始碼

| 檔案 | 說明 |
|------|------|
| `src/core/hooks/runner.ts` | HookRunner 實作 |
| `src/core/hooks/types.ts` | Hook 型別定義 |
| `src/core/hooks/registry.ts` | Hook 註冊管理 |
| `src/plugins/safety-guard/` | 安全防護插件範例 |
| `src/plugins/session-stats/` | 會話統計插件範例 |

---

## 產品經理視角總結

增強 Hook 系統將 Aboocode 從一個封閉產品變成一個可治理的平台。

沒有 Hook，使用者只能接受 Agent 預設的行為。有了 Hook，使用者（和企業）可以：

- **攔截**危險操作（安全團隊關心的）
- **審計**所有行為（合規團隊關心的）
- **修改**輸入輸出（整合團隊關心的）
- **擴展**會話生命週期（自動化團隊關心的）

Hook 系統的關鍵設計決策是**串行執行**和**阻斷語義**。串行確保 Hook 之間的修改是可預測的（A 的修改被 B 看到），阻斷確保安全性 Hook 有最終否決權。
