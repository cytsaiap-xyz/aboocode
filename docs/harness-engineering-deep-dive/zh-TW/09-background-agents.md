# Phase 9 — 後台 Agent 執行需求文檔

> **狀態**: 設計完成  
> **優先級**: P2 — Wave 4 高級 Agent 能力  
> **前置依賴**: Phase 6（流式工具執行器）、Phase 12（工作區隔離）  
> **後置被依賴**: 無

---

## 1. 問題陳述

在典型的 Agent 工作流程中，許多任務是可以並行的。例如：

- 重構程式碼的同時，後台跑測試
- 撰寫新功能的同時，後台搜尋相關文檔
- 修改多個檔案的同時，後台驗證已修改的檔案

但在序列執行模型下，模型必須等待每個子任務完成後才能繼續。**等待是最差的使用者體驗**。

---

## 2. BackgroundTasks 管理器

```typescript
interface BackgroundTask {
  id: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

class BackgroundTasks {
  private tasks: Map<string, BackgroundTask> = new Map();
  private completedQueue: BackgroundTask[] = [];
  
  /**
   * 註冊一個新的後台任務
   */
  register(task: BackgroundTask): void {
    this.tasks.set(task.id, task);
  }
  
  /**
   * 排空已完成的任務（取出並清空佇列）
   * 主迴圈在每次 LLM 呼叫前呼叫此方法
   */
  drain(): BackgroundTask[] {
    const completed = [...this.completedQueue];
    this.completedQueue = [];
    return completed;
  }
  
  /**
   * 查詢所有任務的狀態
   */
  status(): TaskStatusSummary {
    const all = Array.from(this.tasks.values());
    return {
      total: all.length,
      pending: all.filter((t) => t.status === "pending").length,
      running: all.filter((t) => t.status === "running").length,
      completed: all.filter((t) => t.status === "completed").length,
      failed: all.filter((t) => t.status === "failed").length,
      tasks: all,
    };
  }
  
  /**
   * 標記任務完成（內部使用）
   */
  _markCompleted(taskId: string, result: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = "completed";
    task.result = result;
    task.completedAt = new Date().toISOString();
    this.completedQueue.push(task);
  }
  
  /**
   * 標記任務失敗（內部使用）
   */
  _markFailed(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = "failed";
    task.error = error;
    task.completedAt = new Date().toISOString();
    this.completedQueue.push(task);
  }
}

interface TaskStatusSummary {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  tasks: BackgroundTask[];
}
```

---

## 3. TaskTool 的 run_in_background 參數

```typescript
const TaskTool = defineTool({
  name: "task",
  description: "建立子 Agent 任務。可在前台（等待完成）或後台（非阻塞）執行。",
  parameters: z.object({
    description: z.string().describe("任務描述"),
    prompt: z.string().describe("子 Agent 的任務提示"),
    run_in_background: z.boolean().optional().default(false)
      .describe("設為 true 則在後台非阻塞執行"),
    workspace_mode: z.enum(["shared", "readonly", "worktree"]).optional()
      .default("shared"),
  }),
  
  execute: async (params, ctx) => {
    if (params.run_in_background) {
      return await executeBackground(params, ctx);
    } else {
      return await executeForeground(params, ctx);
    }
  },
});
```

### 3.1 後台執行流程

```typescript
async function executeBackground(
  params: TaskParams,
  ctx: ToolContext
): Promise<string> {
  const taskId = generateId();
  
  // 註冊任務
  const task: BackgroundTask = {
    id: taskId,
    description: params.description,
    status: "pending",
    startedAt: new Date().toISOString(),
  };
  ctx.backgroundTasks.register(task);
  
  // 在後台啟動子 Agent（不 await）
  runSubAgent(taskId, params, ctx).catch((error) => {
    ctx.backgroundTasks._markFailed(taskId, error.message);
  });
  
  // 立即回傳，不等待完成
  return `後台任務已啟動: ${params.description} (ID: ${taskId})。` +
    `任務將在背景執行，完成時會自動通知。`;
}

async function runSubAgent(
  taskId: string,
  params: TaskParams,
  ctx: ToolContext
): Promise<void> {
  ctx.backgroundTasks._markRunning(taskId);
  
  // 建立子 Agent 會話
  const subAgent = await createSubAgent({
    prompt: params.prompt,
    workspaceMode: params.workspace_mode,
    parentSessionId: ctx.sessionId,
  });
  
  try {
    const result = await subAgent.run();
    ctx.backgroundTasks._markCompleted(taskId, result);
  } catch (error) {
    ctx.backgroundTasks._markFailed(taskId, String(error));
  }
}
```

---

## 4. 主迴圈整合

主迴圈在每次 LLM 呼叫前 drain 已完成的後台任務，並注入為合成訊息：

```typescript
async function mainLoop(session: Session): Promise<void> {
  while (!session.done) {
    // ▶ 在 LLM 呼叫前 drain 後台任務
    const completedTasks = session.backgroundTasks.drain();
    
    if (completedTasks.length > 0) {
      // 注入合成訊息，告知模型後台任務結果
      for (const task of completedTasks) {
        const syntheticMessage = buildTaskNotification(task);
        session.messages.push(syntheticMessage);
      }
    }
    
    // 微壓縮
    session.messages = microCompact(session.messages);
    
    // 呼叫 LLM
    const response = await llm.chat({
      system: assembleSystemPrompt(session.context),
      messages: session.messages,
    });
    
    // 處理回應
    session.messages.push(response);
    
    // 執行工具呼叫
    if (response.toolCalls) {
      const results = await executor.executeTools(response.toolCalls);
      session.messages.push(...results);
    }
  }
}

function buildTaskNotification(task: BackgroundTask): Message {
  if (task.status === "completed") {
    return {
      role: "system",
      content: `[後台任務完成] ${task.description}\n` +
        `任務 ID: ${task.id}\n` +
        `結果:\n${task.result}`,
    };
  } else {
    return {
      role: "system",
      content: `[後台任務失敗] ${task.description}\n` +
        `任務 ID: ${task.id}\n` +
        `錯誤: ${task.error}`,
    };
  }
}
```

---

## 5. 使用範例

### 5.1 重構程式碼同時後台跑測試

```
使用者: 請重構 src/utils.ts，把那些工具函式拆分到獨立模組。

模型思考:
  1. 先啟動後台測試，確保有基準
  2. 同時進行重構
  3. 重構完成後檢查測試結果

模型行動:
  ┌─ task("後台跑測試", "執行 npm test 並回報結果",
  │       run_in_background: true)
  │
  ├─ read("src/utils.ts")
  ├─ write("src/string-utils.ts", ...)
  ├─ write("src/array-utils.ts", ...)
  ├─ edit("src/utils.ts", ...)
  │
  └─ [下次 LLM 呼叫前，drain 到測試結果]
     [system] 後台任務完成: 3 tests passed, 1 test failed
```

### 5.2 多個後台任務

```
模型行動:
  task("搜尋相關文檔", "...", run_in_background: true)  → ID: bg_001
  task("檢查型別錯誤", "...", run_in_background: true)  → ID: bg_002
  task("Lint 檢查",     "...", run_in_background: true)  → ID: bg_003

  // 主 Agent 繼續工作...
  edit("src/main.ts", ...)

  // 下次 LLM 呼叫前 drain:
  [system] 後台任務完成: 搜尋相關文檔 (bg_001) — 找到 3 份文檔
  [system] 後台任務完成: 檢查型別錯誤 (bg_002) — 0 errors
  [system] 後台任務失敗: Lint 檢查 (bg_003) — 2 warnings in src/main.ts
```

---

## 6. 與工作區隔離的關係

後台任務預設使用 `shared` 工作區，但可以指定隔離模式（Phase 12）：

| 模式 | 適用場景 | 說明 |
|------|----------|------|
| `shared` | 建構、Lint | 共享主工作區 |
| `readonly` | 搜尋、驗證 | 唯讀存取主工作區 |
| `worktree` | 後台修改 | 獨立 Git worktree，避免衝突 |

---

## 驗收標準

- [ ] `BackgroundTasks.register` 正確註冊任務
- [ ] `BackgroundTasks.drain` 回傳已完成任務並清空佇列
- [ ] `BackgroundTasks.status` 回傳正確的統計資訊
- [ ] `TaskTool` 的 `run_in_background: true` 立即回傳
- [ ] 後台子 Agent 在獨立執行緒/Promise 中運行
- [ ] 主迴圈在每次 LLM 呼叫前 drain 後台任務
- [ ] 完成/失敗的任務注入為合成系統訊息
- [ ] 後台任務失敗不影響主 Agent
- [ ] 支援多個後台任務同時運行
- [ ] 單元測試覆蓋 register/drain/status 操作

---

## 參考原始碼

| 檔案 | 說明 |
|------|------|
| `src/core/background/tasks.ts` | BackgroundTasks 管理器 |
| `src/core/background/sub-agent.ts` | 子 Agent 建立與執行 |
| `src/tools/task.ts` | TaskTool 實作 |
| `src/core/agent.ts` | 主迴圈 drain 整合 |

---

## 產品經理視角總結

等待是最差的使用者體驗。

人類開發者不會停下手上的工作去等 `npm test` 跑完——他們會繼續寫程式碼，測試跑完了瞄一眼結果。後台 Agent 執行就是讓 AI Agent 也能這樣工作。

設計的關鍵是 **drain 機制**：後台任務完成後不會打斷主 Agent 的工作流程，而是在下一個自然的「呼吸點」（LLM 呼叫前）注入結果。這保證了主 Agent 的連貫性，同時不遺漏任何後台結果。

搭配工作區隔離（Phase 12），後台任務可以安全地在獨立環境中運行，不會和主 Agent 的檔案操作產生衝突。
