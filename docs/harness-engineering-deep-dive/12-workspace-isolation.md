# 12. 工作区隔离模式需求文档

## 1. 为什么需要工作区隔离

不同 Agent 角色有不同的风险等级：
- **Build Agent** 需要完全读写权限
- **Explore Agent** 只需要读取——如果它意外写入文件，那是 Bug
- **Verify Agent** 必须只读——否则它可能"修复"问题来通过验证
- **后台任务** 不应该与主 Agent 的文件修改冲突

没有隔离，所有 Agent 共享同一个工作目录，任何 Agent 都可以做任何事。这违反了最小权限原则。

## 2. 五级隔离模式

| 模式 | 描述 | 默认 Agent | 文件系统权限 |
|------|------|-----------|-------------|
| `shared` | 主工作目录 | build | 完全读写 |
| `readonly` | 只读访问项目 | explore, verify | 只读 |
| `temp` | 仅限临时目录 | 验证脚本 | 只能写 temp |
| `worktree` | 独立 git worktree | 后台任务 | 隔离的完全读写 |
| `sandbox` | 网络隔离 + 文件隔离 | 不信任的 MCP 工具 | 最小权限 |

## 3. 各模式详解

### 3.1 Shared 模式

最简单的模式——Agent 直接在用户的工作目录中操作。

适用于：
- 主 Build Agent
- 用户明确要求修改的任务

风险：Agent 操作直接影响用户工作区

### 3.2 Readonly 模式

Agent 可以读取所有项目文件，但写操作被拦截。

实现方式：
```typescript
function createReadonlyContext(baseCtx: Tool.Context): Tool.Context {
  return {
    ...baseCtx,
    write: async () => {
      throw new ReadOnlyWorkspaceError(
        "This agent is in readonly mode and cannot modify files"
      )
    },
    edit: async () => {
      throw new ReadOnlyWorkspaceError(
        "This agent is in readonly mode and cannot modify files"
      )
    }
  }
}
```

适用于：
- Explore Agent（代码搜索和分析）
- Verify Agent（验证但不修改）
- 代码审查 Agent

### 3.3 Temp 模式

Agent 只能在临时目录中写入，项目目录完全只读。

```python
def create_temp_workspace():
    temp_dir = mkdtemp(prefix="aboocode-")
    return TempWorkspace(
        project_dir=current_project,  # 只读
        temp_dir=temp_dir,            # 可写
        cleanup=lambda: rmtree(temp_dir)
    )
```

适用于：
- 验证脚本（需要写临时文件但不影响项目）
- 性能测试（写入测试数据到临时目录）

### 3.4 Worktree 模式

创建独立的 git worktree，Agent 在隔离的仓库副本中工作。

```python
def create_worktree_workspace(branch_name=None):
    if not branch_name:
        branch_name = f"aboocode-bg-{uuid4()[:8]}"

    worktree_dir = f"{temp_dir}/worktrees/{branch_name}"
    run(f"git worktree add {worktree_dir} -b {branch_name}")

    return WorktreeWorkspace(
        worktree_dir=worktree_dir,
        branch=branch_name,
        cleanup=lambda: run(f"git worktree remove {worktree_dir}")
    )
```

适用于：
- 后台任务（不与主 Agent 冲突）
- 实验性修改（可以安全丢弃）
- 并行尝试多个方案

### 3.5 Sandbox 模式（未来）

最严格的隔离——网络受限 + 文件受限。目前未实现，为不信任的 MCP 工具预留。

## 4. 隔离模式与 Agent 的映射

```typescript
const DEFAULT_ISOLATION: Record<string, IsolationMode> = {
  build: "shared",
  explore: "readonly",
  verify: "readonly",
  background: "worktree",
}
```

用户可以在 TaskTool 中覆盖默认隔离模式：

```typescript
{
  name: "task",
  parameters: {
    // ...
    isolation?: "shared" | "readonly" | "temp" | "worktree"
  }
}
```

## 5. 伪代码

```python
def create_workspace(isolation_mode, session_ctx):
    if isolation_mode == "shared":
        return SharedWorkspace(cwd=session_ctx.cwd)

    elif isolation_mode == "readonly":
        return ReadonlyWorkspace(
            cwd=session_ctx.cwd,
            blocked_tools=["write", "edit", "apply_patch"]
        )

    elif isolation_mode == "temp":
        temp = mkdtemp()
        return TempWorkspace(
            project_cwd=session_ctx.cwd,  # readonly
            write_cwd=temp,               # writable
            cleanup=lambda: rmtree(temp)
        )

    elif isolation_mode == "worktree":
        branch = f"aboocode-{uuid4()[:8]}"
        wt_dir = f"{tmp}/worktrees/{branch}"
        run(f"git worktree add {wt_dir} -b {branch}")
        return WorktreeWorkspace(
            cwd=wt_dir,
            branch=branch,
            cleanup=lambda: run(f"git worktree remove {wt_dir}")
        )

def apply_isolation(tool_context, workspace):
    """将隔离策略应用到工具上下文"""
    if workspace.readonly:
        # 覆盖写工具为抛异常版本
        for tool_name in workspace.blocked_tools:
            tool_context.override(tool_name, raise_readonly_error)

    tool_context.cwd = workspace.cwd
    return tool_context
```

## 6. 清理策略

| 模式 | 清理时机 | 清理方式 |
|------|---------|---------|
| shared | 不清理 | 用户管理 |
| readonly | 会话结束 | 无需清理 |
| temp | 任务完成 | `rmtree(temp_dir)` |
| worktree | 任务完成 | `git worktree remove` |

如果任务失败且 worktree 有修改，保留 worktree 以供用户检查，并报告路径。

## 7. 与其他 Phase 的交互

| Phase | 交互方式 |
|-------|---------|
| Phase 8 (Background) | 后台任务默认 worktree 隔离 |
| Phase 10 (Verify) | 验证 Agent 默认 readonly 隔离 |
| Phase 9 (Governance) | 隔离通过工具上下文实施，治理管线感知 |

## 8. 验收标准

- [ ] readonly 模式下 write/edit 工具抛出 ReadOnlyWorkspaceError
- [ ] temp 模式下 Agent 只能写入临时目录
- [ ] worktree 模式创建独立的 git worktree
- [ ] worktree 模式的修改不影响主工作目录
- [ ] 任务完成后自动清理临时目录和 worktree
- [ ] worktree 有修改时保留并报告路径
- [ ] 每个 Agent 类型有正确的默认隔离模式

## 9. 源码位置

| 文件 | 职责 |
|------|------|
| `src/worktree/isolation.ts` | 隔离模式抽象和实现 |
| `src/worktree/index.ts` | Worktree 操作 |
| `src/tool/task.ts` | `isolation` 参数处理 |
| `src/agent/agent.ts` | Agent 默认隔离模式映射 |

## 10. 产品经理视角下的总需求句

> 不同角色的 Agent 应该有不同的权限边界——通过五级隔离模式，系统确保只读 Agent 真的只读、后台任务不干扰主流程、验证者无法篡改结果，让权限最小化成为架构保证而不是口头约定。
