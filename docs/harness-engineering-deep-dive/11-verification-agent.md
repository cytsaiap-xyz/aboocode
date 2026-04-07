# 11. 独立验证 Agent 需求文档

## 1. 为什么需要独立验证

在传统 Agent 系统中，执行代码修改的 Agent 同时也负责验证自己的工作。这相当于让学生批改自己的试卷——存在系统性偏差：
- 模型倾向于确认自己的工作是正确的
- 相同的盲点会在实现和验证中重复出现
- "我写了代码并且它编译通过了"不等于"代码正确工作"

独立验证 Agent 的核心原则：**验证者不是实现者**。

## 2. 验证 Agent 定义

### 2.1 角色定位

```
你是验证 Agent。你的职责是独立验证已完成的工作是否正确。

规则：
- 执行实际命令来检查（不要信任描述）
- 测试边界条件和极端情况
- 每项检查报告 PASS / FAIL / PARTIAL，附带命令输出作为证据
- 你只能读取项目文件和写入临时目录
- 不要修复问题——只报告问题
```

### 2.2 Agent 配置

```typescript
{
  name: "verify",
  mode: "subagent",
  permission: {
    read: true,       // 可以读文件
    grep: true,       // 可以搜索
    glob: true,       // 可以查找文件
    bash: true,       // 可以执行命令（只读命令）
    write: false,     // 不能写项目文件
    edit: false,      // 不能编辑项目文件
    apply_patch: false // 不能打补丁
  },
  isolation: "readonly"  // Phase 11 隔离模式
}
```

### 2.3 关键约束

验证 Agent **不能修改项目文件**。这防止了：
- 验证者"修复"问题来让验证通过
- 验证结果被验证过程本身污染
- 实现者和验证者的职责混淆

## 3. VerifyTool

### 3.1 工具定义

```typescript
{
  name: "verify",
  description: "触发独立验证 Agent 检查工作结果",
  parameters: {
    description: string,     // 描述需要验证的内容
    checks?: string[]        // 可选：具体的检查项列表
  }
}
```

### 3.2 使用方式

```
# 模型在完成代码修改后
[tool: verify]
description: "验证新增的 TokenBudget.fromModel() 零值保护逻辑"
checks: [
  "limit.context 为 0 时不触发压缩",
  "limit.context 为正常值时压缩阈值计算正确",
  "shouldCompact 在 maxInputTokens <= 0 时返回 false"
]
```

## 4. 验证报告格式

```markdown
# Verification Report

## Check 1: limit.context 为 0 时不触发压缩
**Status: PASS**
**Evidence:**
```
$ grep -n "maxInputTokens <= 0" src/session/token-budget.ts
47:  if (state.maxInputTokens <= 0) return false
```
零值保护逻辑存在于 shouldCompact 函数中。

## Check 2: shouldCompact 在 maxInputTokens <= 0 时返回 false
**Status: PASS**
**Evidence:**
```
$ bun test token-budget.test.ts
✓ shouldCompact returns false when maxInputTokens is 0
✓ shouldCompact returns false when maxInputTokens is negative
2 tests passed
```

## Overall: PASS (2/2)
```

## 5. 伪代码

```python
async def handle_verify_tool(description, checks, ctx):
    # 构建验证提示
    prompt = VERIFY_SYSTEM_PROMPT + "\n\n"
    prompt += f"请验证以下工作：\n{description}\n\n"

    if checks:
        prompt += "具体检查项：\n"
        for i, check in enumerate(checks):
            prompt += f"{i+1}. {check}\n"

    prompt += "\n对每个检查项，执行实际命令并报告 PASS/FAIL/PARTIAL。"

    # 创建验证子 Agent 会话
    result = await spawn_subagent(
        agent="verify",
        prompt=prompt,
        isolation="readonly",
        parent_session=ctx.session_id
    )

    return format_verification_report(result)
```

## 6. 验证时机

### 6.1 建议使用场景

在 build agent 的系统提示词中建议：

```
在以下情况下考虑调用 verify 工具：
- 完成了涉及多文件修改的复杂任务
- 修复了 Bug（验证修复是否真正生效）
- 重构了关键路径代码
- 修改了安全相关逻辑
```

### 6.2 不应使用的场景

- 简单的文件读取或搜索
- 只添加了注释或文档
- 用户明确表示不需要验证

## 7. 与其他 Phase 的交互

| Phase | 交互方式 |
|-------|---------|
| Phase 8 (Background) | 验证可以作为后台任务运行 |
| Phase 11 (Isolation) | 验证 Agent 使用 `readonly` 隔离模式 |
| Phase 9 (Governance) | 验证工具调用经过治理管线 |

## 8. 验收标准

- [ ] 验证 Agent 不能使用 write/edit/apply_patch 工具
- [ ] 验证 Agent 可以读取项目文件
- [ ] 验证 Agent 可以执行 bash 命令（只读）
- [ ] 验证报告包含 PASS/FAIL/PARTIAL 状态
- [ ] 验证报告包含实际命令输出作为证据
- [ ] 验证失败时不自动修复，只报告
- [ ] VerifyTool 正确创建子 Agent 会话

## 9. 源码位置

| 文件 | 职责 |
|------|------|
| `src/tool/verify.ts` | VerifyTool 定义 |
| `src/agent/agent.ts` | verify agent 注册 |
| `src/agent/prompt/verify.txt` | 验证 Agent 系统提示词 |

## 10. 产品经理视角下的总需求句

> 自我验证是不可靠的——系统需要一个独立的、只读的验证角色，通过实际执行命令而非信任描述来检查工作结果，确保"说做了"等于"真的做对了"。
