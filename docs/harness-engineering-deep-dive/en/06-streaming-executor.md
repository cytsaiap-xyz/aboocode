# 06. Streaming Tool Executor

## 1. Why This Matters

Modern LLMs frequently emit multiple tool calls in a single turn. For example: "Read these 3 files, then grep for the pattern" produces 4 tool calls. Executing them sequentially wastes time — read operations are independent and can run in parallel. But write operations (edit, bash) must be serialized to prevent race conditions.

The streaming executor classifies tools by their concurrency safety and uses a mutex to gate execution, maximizing throughput while preventing data corruption.

## 2. Tool Concurrency Classification

### 2.1 Concurrent-Safe Tools (Read-Only)

These tools have no side effects on the workspace and can safely run in parallel:

```typescript
const CONCURRENT_SAFE_TOOLS = new Set([
  "read",           // Read file contents
  "grep",           // Search file contents
  "glob",           // Find files by pattern
  "websearch",      // Web search (external, no local side effects)
  "webfetch",       // Fetch URL content (external)
  "question",       // Ask user a question (UI only)
  "memory-read",    // Read memory (read-only)
  "codesearch",     // Semantic code search
  "toolsearch",     // Search for deferred tools
])
```

### 2.2 Non-Concurrent Tools (Write/Side-Effect)

These tools modify the workspace or have side effects that require exclusive access:

```typescript
const EXCLUSIVE_TOOLS = new Set([
  "bash",           // Arbitrary command execution
  "edit",           // Modify file content
  "write",          // Create/overwrite file
  "apply_patch",    // Apply diff patch
  "task",           // Create/manage subtasks
  "memory-write",   // Write to memory store
])
```

## 3. Mutex Architecture

### 3.1 Three States

```
┌─────────────────────────────────────────────────┐
│ Executor Mutex States                             │
│                                                   │
│  ┌──────────┐    ┌──────────────┐    ┌────────┐ │
│  │   IDLE    │───▶│  CONCURRENT  │───▶│  IDLE  │ │
│  │           │    │  (N readers) │    │        │ │
│  └──────────┘    └──────────────┘    └────────┘ │
│       │                                    ▲     │
│       │          ┌──────────────┐          │     │
│       └─────────▶│  EXCLUSIVE   │──────────┘     │
│                  │  (1 writer)  │                 │
│                  └──────────────┘                 │
└─────────────────────────────────────────────────┘
```

- **IDLE**: No tools running. Any tool can acquire.
- **CONCURRENT**: One or more concurrent-safe tools are running. Additional concurrent-safe tools can join. Exclusive tools must wait.
- **EXCLUSIVE**: One exclusive tool is running. All other tools must wait.

### 3.2 State Transitions

```
IDLE + concurrent tool request  → CONCURRENT (start tool)
CONCURRENT + concurrent tool    → CONCURRENT (add to running set)
CONCURRENT + exclusive tool     → QUEUE (wait for all concurrent to finish)
CONCURRENT → all finish         → IDLE (drain queue)

IDLE + exclusive tool request   → EXCLUSIVE (start tool)
EXCLUSIVE + any tool            → QUEUE (wait)
EXCLUSIVE → finish              → IDLE (drain queue)
```

## 4. Pseudocode

### 4.1 Executor Core

```python
class StreamingExecutor:
    def __init__(self):
        self.state = IDLE
        self.running = set()     # Currently running tool promises
        self.queue = []          # Waiting tool requests
        self.mutex = Lock()

    async def execute(self, tool_call):
        tool = registry.find(tool_call.name)
        is_concurrent = tool.name in CONCURRENT_SAFE_TOOLS

        async with self.mutex:
            if self.state == IDLE:
                if is_concurrent:
                    self.state = CONCURRENT
                else:
                    self.state = EXCLUSIVE
                self._start(tool_call)

            elif self.state == CONCURRENT:
                if is_concurrent:
                    # Join existing concurrent batch
                    self._start(tool_call)
                else:
                    # Must wait for concurrent batch to finish
                    self._enqueue(tool_call)

            elif self.state == EXCLUSIVE:
                # Must wait for exclusive tool to finish
                self._enqueue(tool_call)

    def _start(self, tool_call):
        promise = self._run_tool(tool_call)
        self.running.add(promise)
        promise.then(lambda: self._on_complete(promise))

    def _enqueue(self, tool_call):
        future = Future()
        self.queue.append((tool_call, future))
        return future

    def _on_complete(self, promise):
        self.running.discard(promise)
        if len(self.running) == 0:
            self.state = IDLE
            self._drain_queue()

    def _drain_queue(self):
        if not self.queue:
            return

        # Check if next batch is all concurrent
        batch = []
        for tool_call, future in self.queue:
            tool = registry.find(tool_call.name)
            if tool.name in CONCURRENT_SAFE_TOOLS and (not batch or batch[0][1]):
                batch.append((tool_call, future, True))
            else:
                if not batch:
                    batch.append((tool_call, future, False))
                break

        # Start the batch
        for tool_call, future, is_concurrent in batch:
            self.queue.remove((tool_call, future))
            if is_concurrent:
                self.state = CONCURRENT
            else:
                self.state = EXCLUSIVE
            self._start(tool_call)
            future.resolve()
```

### 4.2 Abort Siblings on Bash Error

When a `bash` tool returns a non-zero exit code, sibling tool calls in the same turn should be aborted — they likely depend on the bash result:

```python
def on_bash_result(result, turn_tool_calls):
    if result.exit_code != 0:
        for sibling in turn_tool_calls:
            if sibling.status == PENDING or sibling.status == QUEUED:
                sibling.abort("Aborted: sibling bash command failed")
                log.warn(f"Aborted {sibling.tool}:{sibling.id} due to bash failure")
```

## 5. Streaming Integration

### 5.1 Tool Calls Arrive as Streamed Tokens

The LLM streams tool calls incrementally. The executor must handle partial tool call data:

```python
async def process_stream(stream):
    pending_calls = {}

    async for chunk in stream:
        if chunk.type == "tool_call_start":
            pending_calls[chunk.id] = ToolCall(id=chunk.id, name=chunk.name)

        elif chunk.type == "tool_call_delta":
            pending_calls[chunk.id].args += chunk.delta

        elif chunk.type == "tool_call_end":
            call = pending_calls.pop(chunk.id)
            call.args = json.parse(call.args)
            # Submit to executor (non-blocking for concurrent tools)
            executor.execute(call)
```

## 6. Data Structures

```typescript
interface ToolExecution {
  id: string
  toolName: string
  args: Record<string, unknown>
  status: "pending" | "running" | "completed" | "failed" | "aborted"
  startedAt?: Date
  completedAt?: Date
  result?: ToolResult
  error?: Error
}

interface ExecutorState {
  mode: "idle" | "concurrent" | "exclusive"
  running: Set<string>       // Tool execution IDs
  queueLength: number
  totalExecuted: number
  totalAborted: number
}

interface ToolDefinition {
  name: string
  concurrentSafe: boolean    // Determines classification
  // ... other tool properties
}
```

## 7. Acceptance Criteria

- [ ] Multiple concurrent-safe tools in one turn execute in parallel (wall-clock time < sum of individual times)
- [ ] Exclusive tools execute one at a time with no overlap
- [ ] A concurrent-safe tool submitted while an exclusive tool runs is queued until the exclusive tool finishes
- [ ] An exclusive tool submitted while concurrent tools run is queued until all concurrent tools finish
- [ ] Bash failure aborts pending sibling tool calls in the same turn
- [ ] Queue drains in FIFO order when the mutex returns to IDLE
- [ ] Executor state transitions are atomic (no race conditions)
- [ ] Streamed tool calls are correctly assembled before execution

## 8. Source Files

| File | Responsibility |
|------|------|
| `src/session/executor.ts` | Streaming executor with mutex and queue |
| `src/tool/tool.ts` | Tool definitions with concurrentSafe flag |
| `src/session/prompt.ts` | Feeds streamed tool calls to the executor |

## 9. Product Manager Summary

> Multiple tool calls in a single turn is the norm — the system must parallelize read-only operations while gating write operations through a mutex.
