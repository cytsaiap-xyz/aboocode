# 02. 系统提示词动态边界需求文档

## 1. 为什么系统提示词需要分层

系统提示词（System Prompt）是 LLM 每次调用都会发送的指令。一个完整的 Aboocode 系统提示词可能包含：
- 模型行为指令（固定不变）
- 工具使用规范（固定不变）
- 安全约束（固定不变）
- 环境信息（每会话变化）
- 用户自定义指令（每项目变化）
- 记忆内容（每次可能变化）
- MCP 工具列表（动态加载）

如果把这些全部拼成一个字符串，任何动态部分的变化都会导致**整个提示词缓存失效**，浪费大量 token 费用。

## 2. 分层架构

### 2.1 静态层（Global Scope）

内容在整个应用生命周期内不变：
- 模型身份和行为规范
- 工具使用优先级规则
- 安全约束和审计要求
- 输出格式规范

### 2.2 动态层（Session Scope）

内容可能因会话、项目或配置变化：
- 当前工作目录和环境信息
- CLAUDE.md / AGENTS.md 用户指令
- 记忆系统内容（Phase 4）
- MCP 工具描述
- 延迟工具名称列表（Phase 7）
- 身份重注入内容（Phase 3）

## 3. Provider-Agnostic 缓存策略

### 3.1 Anthropic Provider

Anthropic API 支持 `cache_control` 标注，允许在多个消息间缓存静态内容：

```typescript
// transform.ts — Anthropic 专用
function buildSystemBlocks(sections: SystemSection[]): SystemBlock[] {
  return [
    {
      type: "text",
      text: sections.filter(s => s.scope === "global").map(s => s.text).join("\n"),
      cache_control: { type: "ephemeral" }  // 标记为可缓存
    },
    {
      type: "text",
      text: sections.filter(s => s.scope === "session").map(s => s.text).join("\n")
    }
  ]
}
```

### 3.2 其他 Provider（OpenAI、Google 等）

不支持 cache_control 的 provider，直接拼接为单一字符串：

```typescript
// transform.ts — 通用
function buildSystemString(sections: SystemSection[]): string {
  return sections.map(s => s.text).join("\n\n")
}
```

### 3.3 效果

对于 Anthropic provider，静态层只在首次请求时计费，后续请求命中缓存。对于一个 ~4000 token 的静态层，10 次调用可以节省 ~36000 input tokens。

## 4. 数据结构

```typescript
interface SystemSection {
  text: string
  scope: "global" | "session" | null
}

// system.ts
function staticPrompt(model: ModelInfo): SystemSection[] {
  return [
    { text: modelInstructions(model), scope: "global" },
    { text: toolGuidance(), scope: "global" },
    { text: safetyConstraints(), scope: "global" },
  ]
}

function dynamicPrompt(model: ModelInfo, ctx: SessionContext): SystemSection[] {
  return [
    { text: environmentInfo(ctx), scope: "session" },
    { text: userInstructions(ctx), scope: "session" },
    { text: memoryContent(ctx), scope: "session" },
    { text: mcpToolList(ctx), scope: "session" },
    { text: identityBlock(ctx), scope: "session" },
  ]
}
```

## 5. 与其他 Phase 的交互

| Phase | 交互方式 |
|-------|---------|
| Phase 3 (Identity) | 压缩后注入身份块到动态层 |
| Phase 4 (Memory) | 记忆内容注入到动态层 |
| Phase 7 (ToolSearch) | 延迟工具名单注入到动态层 |
| Phase 0 (Compression) | 静态层缓存减少 token 预算压力 |

## 6. 伪代码

```python
def build_system_prompt(model, session_ctx):
    static = static_prompt(model)
    dynamic = dynamic_prompt(model, session_ctx)
    sections = static + dynamic

    if provider_supports_cache(model.provider):
        return split_into_cached_blocks(sections)
    else:
        return concatenate(sections)
```

## 7. 验收标准

- [ ] Anthropic provider 发送的系统提示词包含两个 text block
- [ ] 第一个 block 带有 `cache_control: { type: "ephemeral" }`
- [ ] 动态内容变化时，静态 block 内容不变（可通过 hash 验证）
- [ ] 非 Anthropic provider 正常拼接为单一字符串
- [ ] 记忆内容、MCP 工具列表只出现在动态层

## 8. 源码位置

| 文件 | 职责 |
|------|------|
| `src/session/system.ts` | 构建 static/dynamic sections |
| `src/session/llm.ts` | 组装 sections 传递给 provider |
| `src/provider/transform.ts` | Provider-specific 格式转换 |

## 9. 产品经理视角下的总需求句

> 系统提示词是每次 LLM 调用的固定成本——通过将其分为可缓存的静态层和按需更新的动态层，系统可以在不牺牲灵活性的前提下大幅降低 token 消耗，同时为记忆注入、身份恢复等机制提供干净的扩展点。
