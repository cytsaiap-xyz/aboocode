# 12. Workspace Isolation Modes

## 1. Why This Matters

Different agent roles need different permission boundaries. A verification agent should not be able to write files. A background task should not conflict with the main agent's uncommitted changes. An untrusted MCP server should not access the user's workspace at all.

Without isolation, all agents share the same workspace with the same permissions — a single misbehaving plugin or hallucinating sub-agent can corrupt the entire project. Workspace isolation provides five levels of access control, ensuring the principle of least privilege.

## 2. Five Isolation Levels

```
Level 0: SHARED (default)
  Full read/write access to the main workspace.
  Used by: Main agent, build tasks.

Level 1: READONLY
  Can read all files, cannot write/edit/patch any files.
  Used by: Verification agent, exploration tasks.

Level 2: TEMP
  Runs in a temporary directory. Can create files there.
  Cannot access the main workspace.
  Used by: Verification scripts, throwaway experiments.

Level 3: WORKTREE
  Runs in a git worktree (separate checkout of the same repo).
  Full read/write within the worktree. Isolated from main working tree.
  Used by: Background tasks that need to modify code.

Level 4: SANDBOX (future)
  Runs in a containerized environment with no host access.
  Used by: Untrusted MCP servers, third-party plugins.
```

### 2.1 Level Comparison

| Level | Read Main WS | Write Main WS | Own Filesystem | Git Isolated | Use Case |
|-------|-------------|---------------|----------------|-------------|----------|
| SHARED | Yes | Yes | N/A | No | Main agent |
| READONLY | Yes | No | No | No | Verification |
| TEMP | No | No | Yes (tmpdir) | N/A | Scripts |
| WORKTREE | No | No | Yes (worktree) | Yes | Background |
| SANDBOX | No | No | Yes (container) | Yes | Untrusted |

## 3. Level 1: READONLY Enforcement

### 3.1 Mechanism

READONLY does not use filesystem permissions (which would require OS-level sandboxing). Instead, it intercepts write tool calls at the governance layer:

```python
WRITE_TOOLS = {"write", "edit", "apply_patch", "memory-write"}

def enforce_isolation(agent, tool_call):
    if agent.isolation == "readonly":
        if tool_call.name in WRITE_TOOLS:
            raise ReadOnlyWorkspaceError(
                agent=agent.name,
                tool=tool_call.name,
                message=(
                    f"Agent '{agent.name}' is in read-only mode. "
                    f"Cannot execute '{tool_call.name}'."
                )
            )

    elif agent.isolation == "temp":
        if tool_call.name in {"read", "grep", "glob"}:
            # Verify path is within temp directory
            enforce_path_within(tool_call.args, agent.tempDir)

    elif agent.isolation == "worktree":
        if tool_call.name in {"read", "write", "edit", "grep", "glob"}:
            # Redirect paths to worktree
            redirect_paths(tool_call.args, agent.worktreePath)
```

### 3.2 Error Response

When a read-only agent attempts to write, the error is returned to the model as a tool result (not a crash):

```json
{
  "type": "tool_result",
  "tool": "edit",
  "error": true,
  "content": "ReadOnlyWorkspaceError: Agent 'verifier' is in read-only mode. Cannot execute 'edit'. You can only use read, grep, glob, and bash (read-only commands) in verification mode."
}
```

The model can then adjust its approach (e.g., report the issue rather than trying to fix it).

## 4. Level 2: TEMP Directory

### 4.1 Creation

```python
def create_temp_workspace(session_id, description):
    temp_dir = mkdtemp(prefix=f"aboocode-temp-{session_id[:8]}-")
    return TempWorkspace(
        path=temp_dir,
        sessionId=session_id,
        description=description,
        createdAt=now(),
    )
```

### 4.2 Cleanup

Temp directories are cleaned up when the task completes:

```python
def cleanup_temp_workspace(workspace):
    if exists(workspace.path):
        rmtree(workspace.path)
        log.info(f"Cleaned up temp workspace: {workspace.path}")
```

## 5. Level 3: WORKTREE Isolation

### 5.1 Git Worktree Creation

Git worktrees provide a full checkout of the repository at a separate path. Changes in the worktree do not affect the main working tree.

```python
def create_worktree(session_id, branch_name=None):
    worktree_dir = f"/tmp/aboocode-worktree-{session_id[:8]}-{uuid4()[:8]}"

    if branch_name:
        # Create worktree on existing branch
        run(f"git worktree add {worktree_dir} {branch_name}")
    else:
        # Create worktree on a new branch
        new_branch = f"aboocode-bg-{session_id[:8]}"
        run(f"git worktree add -b {new_branch} {worktree_dir}")

    return WorktreeWorkspace(
        path=worktree_dir,
        sessionId=session_id,
        branch=branch_name or new_branch,
        createdAt=now(),
    )
```

### 5.2 Worktree Cleanup

Worktree cleanup is more careful than temp cleanup — it must preserve work if changes exist:

```python
def cleanup_worktree(workspace):
    # Check for uncommitted changes
    result = run(f"git -C {workspace.path} status --porcelain")

    if result.stdout.strip():
        # Has uncommitted changes — preserve, warn user
        log.warn(
            f"Worktree {workspace.path} has uncommitted changes. "
            f"Preserving worktree. Clean up manually with: "
            f"git worktree remove {workspace.path}"
        )
        return

    # Safe to remove
    run(f"git worktree remove {workspace.path}")
    log.info(f"Cleaned up worktree: {workspace.path}")
```

## 6. Level 4: SANDBOX (Future)

The sandbox level is reserved for future implementation. It will use containerization (e.g., Docker, gVisor) to provide:
- No host filesystem access
- Network restrictions
- Resource limits (CPU, memory, time)
- Used for untrusted MCP servers and third-party plugins

```python
# Future implementation sketch
def create_sandbox(config):
    container = docker.create(
        image="aboocode-sandbox:latest",
        mounts=[],                    # No host mounts
        network="none",               # No network
        cpu_limit=config.cpu_limit,
        memory_limit=config.memory_limit,
        timeout=config.timeout,
    )
    return SandboxWorkspace(container=container)
```

## 7. Data Structures

```typescript
type IsolationLevel = "shared" | "readonly" | "temp" | "worktree" | "sandbox"

interface WorkspaceConfig {
  isolation: IsolationLevel
  mainWorkspacePath: string
  tempDir?: string              // For TEMP level
  worktreePath?: string         // For WORKTREE level
  sandboxId?: string            // For SANDBOX level
}

interface WorktreeWorkspace {
  path: string
  sessionId: string
  branch: string
  createdAt: Date
  hasUncommittedChanges?: boolean
}

interface TempWorkspace {
  path: string
  sessionId: string
  description: string
  createdAt: Date
}
```

## 8. Integration with Agent Roles

Each agent role maps to a default isolation level:

| Agent Role | Default Isolation | Rationale |
|-----------|------------------|-----------|
| Main agent | SHARED | Needs full access to implement changes |
| Verification agent | READONLY | Must observe without modifying |
| Background task (read) | READONLY | e.g., running analysis |
| Background task (write) | WORKTREE | e.g., running refactoring in parallel |
| Temp script runner | TEMP | Throwaway scripts that should not persist |
| MCP server (trusted) | SHARED | Trusted server with approved tools |
| MCP server (untrusted) | SANDBOX | Untrusted server, fully isolated |

## 9. Pseudocode: Isolation Manager

```python
class IsolationManager:
    def __init__(self, main_workspace):
        self.main_workspace = main_workspace
        self.active_workspaces = {}

    def create_workspace(self, agent, isolation_level):
        if isolation_level == "shared":
            return SharedWorkspace(path=self.main_workspace)

        elif isolation_level == "readonly":
            return ReadOnlyWorkspace(path=self.main_workspace)

        elif isolation_level == "temp":
            ws = create_temp_workspace(agent.sessionId, agent.description)
            self.active_workspaces[ws.path] = ws
            return ws

        elif isolation_level == "worktree":
            ws = create_worktree(agent.sessionId)
            self.active_workspaces[ws.path] = ws
            return ws

        elif isolation_level == "sandbox":
            raise NotImplementedError("Sandbox isolation is planned for a future release")

    def cleanup(self, workspace):
        if isinstance(workspace, TempWorkspace):
            cleanup_temp_workspace(workspace)
        elif isinstance(workspace, WorktreeWorkspace):
            cleanup_worktree(workspace)
        self.active_workspaces.pop(workspace.path, None)

    def cleanup_all(self):
        for ws in list(self.active_workspaces.values()):
            self.cleanup(ws)
```

## 10. Acceptance Criteria

- [ ] READONLY agents cannot execute write, edit, or apply_patch tools
- [ ] READONLY violation returns ReadOnlyWorkspaceError as a tool result (not a crash)
- [ ] TEMP workspace creates a unique temporary directory per task
- [ ] TEMP workspace is deleted (rmtree) when the task completes
- [ ] WORKTREE workspace creates a git worktree in a temporary location
- [ ] WORKTREE cleanup preserves the worktree if there are uncommitted changes
- [ ] WORKTREE cleanup removes the worktree if it is clean
- [ ] File path operations in TEMP and WORKTREE are confined to their directories
- [ ] Each agent role maps to an appropriate default isolation level

## 11. Source Files

| File | Responsibility |
|------|------|
| `src/worktree/isolation.ts` | IsolationManager, level enforcement |
| `src/worktree/index.ts` | Git worktree creation and cleanup |
| `src/tool/task.ts` | Passes isolation level when creating subtasks |
| `src/agent/agent.ts` | Agent definition with isolation config |

## 12. Product Manager Summary

> Different agent roles need different permission boundaries — five isolation levels ensure read-only agents truly cannot write.
