# 09. Background Agent Execution

## 1. Why This Matters

Engineering workflows frequently involve long-running operations: test suites, builds, deployments, large-scale refactors. In a traditional agent loop, these block the main conversation — the user and model sit idle while tests run for 5 minutes.

Background agent execution allows subtasks to run in parallel with the main conversation. The model can start a test suite in the background, continue coding, and be notified when tests complete. This mirrors how human engineers work — they do not stare at the terminal waiting for tests.

## 2. Architecture

```
Main Agent Loop
  User -> LLM -> Tool -> LLM -> Tool -> ...
                  |
                  | task(run_in_background=true)
                  v
  BackgroundTasks
    [Task 1: running] [Task 2: done] [Task 3: pending]
    drain_completed() -> inject into main loop

  Main loop continues without waiting...
  Before next LLM call:
    completed = background.drain()
    if completed: inject as synthetic messages
```

## 3. BackgroundTasks Namespace

### 3.1 Interface

```typescript
namespace BackgroundTasks {
  // Register a new background task
  function register(task: BackgroundTask): string  // returns task ID

  // Drain all completed tasks (removes them from the queue)
  function drain(sessionId: string): CompletedTask[]

  // Get status of all tasks
  function status(sessionId: string): TaskStatus[]
}

interface BackgroundTask {
  sessionId: string
  description: string
  promise: Promise<TaskResult>
  startedAt: Date
}

interface CompletedTask {
  id: string
  description: string
  result: TaskResult
  startedAt: Date
  completedAt: Date
  durationMs: number
}

interface TaskStatus {
  id: string
  description: string
  state: "pending" | "running" | "completed" | "failed"
  startedAt: Date
  completedAt?: Date
}

interface TaskResult {
  success: boolean
  output: string
  error?: string
}
```

## 4. TaskTool Integration

### 4.1 The run_in_background Parameter

The existing task tool gains a run_in_background boolean parameter:

```typescript
interface TaskToolInput {
  description: string
  // ... existing task parameters ...
  run_in_background?: boolean  // NEW: if true, execute without blocking
}
```

### 4.2 Execution Flow

```python
async def task_execute(input):
    if input.run_in_background:
        # Start task without awaiting
        promise = start_subtask(input)
        task_id = background.register(BackgroundTask(
            sessionId=current_session_id(),
            description=input.description,
            promise=promise,
            startedAt=now(),
        ))

        # Return immediately
        return ToolResult(
            content=f"Background task started: {input.description}\n"
                    f"Task ID: {task_id}\n"
                    f"You will be notified when it completes.",
            metadata={ "backgroundTaskId": task_id }
        )
    else:
        # Standard synchronous execution
        result = await start_subtask(input)
        return format_task_result(result)
```

## 5. Notification Injection

### 5.1 Drain Before Each LLM Call

Before each LLM call in the main loop, the system checks for completed background tasks:

```python
def prepare_llm_call(session):
    # Drain completed background tasks
    completed = background.drain(session.id)

    if completed:
        for task in completed:
            # Inject as synthetic system message
            inject_message(session.id, {
                role: "system",
                content: format_task_completion(task),
                metadata: { type: "background_task_completion" }
            })

def format_task_completion(task):
    status = "succeeded" if task.result.success else "failed"
    return (
        f"[Background Task Completed]\n"
        f"Task: {task.description}\n"
        f"Status: {status}\n"
        f"Duration: {task.durationMs}ms\n"
        f"Output:\n{task.result.output}"
    )
```

### 5.2 Model Sees Completions Naturally

The synthetic messages appear in the conversation as system notifications. The model then reacts to results. For example, if tests fail while the model is refactoring, it can immediately address the failures.

## 6. Example Workflow

A typical background agent workflow:

1. User asks: "Refactor the auth module and make sure all tests pass"
2. Model starts refactoring the auth module (synchronous tool calls)
3. Model starts the full test suite via `task(run_in_background=true)`
4. Model receives immediate confirmation: "Background task started"
5. Model continues refactoring (additional file edits)
6. Before the next LLM call, the system drains completed tasks
7. Model sees: "[Background Task Completed] 142 tests passed, 0 failed"
8. Model reports success to the user

If tests had failed, the model would see the failure output and could address the issues without the user needing to re-request.

## 7. Workspace Isolation for Background Tasks

Background tasks may need workspace isolation to avoid conflicts with the main agent's work. Integration with Phase 11 (Workspace Isolation):

```python
async def start_background_subtask(input):
    if input.needs_isolation:
        # Create a git worktree for the background task
        worktree = await create_worktree(session.id, input.description)
        return run_in_worktree(worktree, input)
    else:
        # Run in shared workspace (read-only tasks)
        return run_subtask(input)
```

## 8. Data Structures

```typescript
interface BackgroundTaskRegistry {
  tasks: Map<string, BackgroundTaskEntry>
  completedQueue: CompletedTask[]
}

interface BackgroundTaskEntry {
  id: string
  sessionId: string
  description: string
  state: "running" | "completed" | "failed"
  promise: Promise<TaskResult>
  startedAt: Date
  completedAt?: Date
  result?: TaskResult
  worktreePath?: string    // If running in isolated worktree
}
```

## 9. Acceptance Criteria

- [ ] `task(run_in_background=true)` returns immediately without awaiting the subtask
- [ ] Background task promise is registered in BackgroundTasks
- [ ] `background.drain()` returns only completed tasks and removes them from the queue
- [ ] Completed tasks are injected as synthetic system messages before the next LLM call
- [ ] Multiple background tasks can run concurrently
- [ ] Background task failures are reported to the model (not silently swallowed)
- [ ] `background.status()` returns the current state of all tasks
- [ ] The main agent loop is never blocked by a background task

## 10. Source Files

| File | Responsibility |
|------|------|
| `src/session/background.ts` | BackgroundTasks namespace: register, drain, status |
| `src/tool/task.ts` | TaskTool with run_in_background parameter |
| `src/session/prompt.ts` | Drains completed tasks and injects notifications |

## 11. Product Manager Summary

> Waiting is the worst UX — background execution lets subtasks run parallel to the main loop, so the model works like an engineer who can multitask.
