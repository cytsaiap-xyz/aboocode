# Phase 6 — 流式工具執行器需求文檔

> **狀態**: 設計完成  
> **優先級**: P1 — Wave 2 核心能力  
> **前置依賴**: 無  
> **後置被依賴**: Phase 10（工具治理管線）

---

## 1. 問題陳述

LLM 在一次回應中可能同時請求多個工具呼叫。例如：

```
模型回應:
  1. Read("src/utils.ts")
  2. Read("src/types.ts")
  3. Grep("TODO", "src/")
```

天真的實作會序列執行這些工具，但 Read 和 Grep 都是唯讀的，完全可以並行。然而：

```
模型回應:
  1. Read("src/utils.ts")
  2. Edit("src/utils.ts", ...)
  3. Read("src/utils.ts")
```

這裡 Edit 必須在第一個 Read 之後、第二個 Read 之前執行，否則會產生資料競態。

**核心問題**：如何安全地最大化工具的並發度？

---

## 2. 工具並發分類

### 2.1 可並發工具（唯讀操作）

```typescript
const CONCURRENT_TOOLS = new Set([
  "read",          // 讀取檔案
  "grep",          // 搜尋內容
  "glob",          // 搜尋檔案
  "websearch",     // 網頁搜尋
  "webfetch",      // 網頁擷取
  "question",      // 向使用者提問
  "memory-read",   // 讀取記憶
  "codesearch",    // 程式碼搜尋
  "toolsearch",    // 工具搜尋
]);
```

**特點**：這些工具不修改任何狀態，可以任意數量同時執行。

### 2.2 互斥工具（寫入或副作用操作）

```typescript
const EXCLUSIVE_TOOLS = new Set([
  "bash",          // Shell 命令（可能修改檔案系統）
  "edit",          // 編輯檔案
  "write",         // 寫入檔案
  "apply_patch",   // 套用修補檔案
  "task",          // 子任務（可能有副作用）
  "memory-write",  // 寫入記憶
]);
```

**特點**：這些工具有副作用，必須獨佔執行。在互斥工具執行期間，不能有其他工具（包括唯讀工具）同時運行。

---

## 3. Mutex 三態模型

```typescript
enum MutexState {
  /** 空閒，沒有工具在執行 */
  IDLE = "IDLE",
  
  /** 並發模式，一個或多個唯讀工具在執行 */
  CONCURRENT = "CONCURRENT",
  
  /** 獨佔模式，一個互斥工具在執行 */
  EXCLUSIVE = "EXCLUSIVE",
}
```

### 3.1 狀態轉換規則

```
IDLE ──(並發工具)──→ CONCURRENT
IDLE ──(互斥工具)──→ EXCLUSIVE

CONCURRENT ──(並發工具)──→ CONCURRENT（允許加入）
CONCURRENT ──(互斥工具)──→ 等待所有並發完成 → EXCLUSIVE
CONCURRENT ──(全部完成)──→ IDLE

EXCLUSIVE ──(任何工具)──→ 排隊等待
EXCLUSIVE ──(完成)──→ IDLE → 處理佇列
```

### 3.2 Mutex 實作

```typescript
class ToolMutex {
  private state: MutexState = MutexState.IDLE;
  private activeConcurrent: number = 0;
  private queue: QueuedTool[] = [];
  
  async acquire(toolName: string): Promise<void> {
    const isExclusive = EXCLUSIVE_TOOLS.has(toolName);
    
    if (isExclusive) {
      await this.acquireExclusive();
    } else {
      await this.acquireConcurrent();
    }
  }
  
  private async acquireExclusive(): Promise<void> {
    // 如果有任何工具在執行，排隊等待
    if (this.state !== MutexState.IDLE) {
      await this.waitForIdle();
    }
    this.state = MutexState.EXCLUSIVE;
  }
  
  private async acquireConcurrent(): Promise<void> {
    // 如果處於獨佔模式，排隊等待
    if (this.state === MutexState.EXCLUSIVE) {
      await this.waitForIdle();
    }
    this.state = MutexState.CONCURRENT;
    this.activeConcurrent++;
  }
  
  release(toolName: string): void {
    const isExclusive = EXCLUSIVE_TOOLS.has(toolName);
    
    if (isExclusive) {
      this.state = MutexState.IDLE;
    } else {
      this.activeConcurrent--;
      if (this.activeConcurrent === 0) {
        this.state = MutexState.IDLE;
      }
    }
    
    // 處理等待佇列
    this.drainQueue();
  }
  
  private async waitForIdle(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
    });
  }
  
  private drainQueue(): void {
    if (this.state !== MutexState.IDLE) return;
    if (this.queue.length === 0) return;
    
    // 釋放佇列中的第一個等待者
    const next = this.queue.shift();
    next?.resolve();
  }
}

interface QueuedTool {
  resolve: () => void;
}
```

---

## 4. 流式執行器

```typescript
class StreamingToolExecutor {
  private mutex = new ToolMutex();
  
  async executeTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = new Array(toolCalls.length);
    
    // 將工具呼叫分為可並發和互斥兩組
    const concurrent: IndexedToolCall[] = [];
    const exclusive: IndexedToolCall[] = [];
    
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = { index: i, call: toolCalls[i] };
      if (CONCURRENT_TOOLS.has(toolCalls[i].name)) {
        concurrent.push(tc);
      } else {
        exclusive.push(tc);
      }
    }
    
    // 並發工具同時執行
    const concurrentPromises = concurrent.map(async (tc) => {
      await this.mutex.acquire(tc.call.name);
      try {
        results[tc.index] = await this.executeSingle(tc.call);
      } finally {
        this.mutex.release(tc.call.name);
      }
    });
    
    // 互斥工具按順序排隊
    const exclusivePromise = (async () => {
      for (const tc of exclusive) {
        await this.mutex.acquire(tc.call.name);
        try {
          results[tc.index] = await this.executeSingle(tc.call);
        } finally {
          this.mutex.release(tc.call.name);
        }
      }
    })();
    
    await Promise.all([...concurrentPromises, exclusivePromise]);
    
    return results;
  }
  
  private async executeSingle(call: ToolCall): Promise<ToolResult> {
    // 實際執行工具（經過治理管線，Phase 10）
    return await toolRunner.run(call.name, call.arguments);
  }
}

interface IndexedToolCall {
  index: number;
  call: ToolCall;
}
```

---

## 5. abortSiblings 機制

當一個互斥工具（特別是 `bash`）失敗時，排隊中的後續工具可能已經沒有意義（例如 `bash` 安裝套件失敗後，後續的測試也沒意義）。

```typescript
interface AbortPolicy {
  /** 觸發中止的工具名稱 */
  trigger: string;
  /** 是否中止排隊中的工具 */
  abortQueued: boolean;
  /** 中止的錯誤類型 */
  errorTypes: string[];
}

const DEFAULT_ABORT_POLICY: AbortPolicy = {
  trigger: "bash",
  abortQueued: true,
  errorTypes: ["non_zero_exit", "timeout"],
};

class StreamingToolExecutor {
  // ...
  
  private handleToolFailure(
    failedTool: ToolCall,
    error: ToolError,
    policy: AbortPolicy
  ): void {
    if (
      failedTool.name === policy.trigger &&
      policy.abortQueued &&
      policy.errorTypes.includes(error.type)
    ) {
      // 取消所有排隊中的工具
      this.mutex.abortQueue(
        new Error(`已中止：${failedTool.name} 執行失敗 — ${error.message}`)
      );
    }
  }
}
```

---

## 6. 執行時序範例

### 範例 1：全部可並發

```
模型請求: Read(a.ts), Read(b.ts), Grep("TODO")

時間線：
  t0: ┌── Read(a.ts) ──────────────┐
  t0: ├── Read(b.ts) ──────┐       │
  t0: └── Grep("TODO") ────┘       │
  t1:                       完成     完成
```

### 範例 2：混合操作

```
模型請求: Read(a.ts), Edit(a.ts, ...), Read(a.ts)

時間線：
  t0: ── Read(a.ts) ──┐
  t1:                  └─ Edit(a.ts) ──┐
  t2:                                   └─ Read(a.ts) ──┐
  t3:                                                    完成
```

### 範例 3：bash 失敗中止

```
模型請求: Bash("npm install"), Bash("npm test"), Read("coverage.json")

時間線：
  t0: ── Bash("npm install") ──✗ 失敗
  t1:    Bash("npm test") ──── [已中止]
  t1:    Read("coverage.json")── [已中止]
```

---

## 驗收標準

- [ ] 可並發工具可以同時執行
- [ ] 互斥工具獨佔執行，不與其他工具同時運行
- [ ] Mutex 三態轉換正確（IDLE ↔ CONCURRENT ↔ EXCLUSIVE）
- [ ] 佇列排空機制正確（FIFO 順序）
- [ ] abortSiblings 機制在 bash 失敗時取消排隊中的工具
- [ ] 工具結果按原始順序回傳（不因並發而亂序）
- [ ] 不產生死鎖（所有路徑最終回到 IDLE）
- [ ] 壓力測試：100 個並發 Read 不崩潰
- [ ] 單元測試覆蓋三態轉換的所有路徑

---

## 參考原始碼

| 檔案 | 說明 |
|------|------|
| `src/core/executor/mutex.ts` | ToolMutex 實作 |
| `src/core/executor/streaming.ts` | StreamingToolExecutor |
| `src/core/executor/classify.ts` | 工具並發分類 |
| `src/core/executor/abort.ts` | abortSiblings 策略 |

---

## 產品經理視角總結

流式工具執行器用 mutex 門控區分唯讀和寫入操作，在保證安全的前提下最大化並發。

這和作業系統的讀寫鎖（Read-Write Lock）是完全相同的概念：多個讀取者可以同時存取資源，但寫入者必須獨佔。唯一的區別是我們的「資源」不是記憶體位址，而是整個工作環境——檔案系統、Git 倉庫、外部服務。

abortSiblings 機制則是實用主義的體現：當前置操作失敗時，後續依賴它的操作沒有執行的意義。與其讓它們執行後再處理錯誤，不如直接取消，節省時間和資源。
