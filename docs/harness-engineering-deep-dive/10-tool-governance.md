# 10. 工具治理管线需求文档

## 1. 为什么工具需要治理

工具不是简单的函数调用。在生产环境中，每次工具执行：
- 可能有安全风险（shell 注入、文件越权）
- 需要审计追踪（谁在什么时候做了什么）
- 可能需要额外校验（参数合理性、路径安全性）
- 需要遵守组织策略（不允许删除、不允许访问某些目录）

简单的"调用 → 执行 → 返回"无法满足这些需求。工具需要被**治理**。

## 2. 8 步执行链

```
┌─────────────────────────────────────────────────┐
│                工具治理管线                        │
│                                                 │
│  1. findTool(name)         → Tool.Info          │
│  2. validateInput(schema)  → parsed args (Zod)  │
│  3. runCustomValidators()  → validated args      │
│  4. firePreToolUseHooks()  → modified args / block │
│  5. resolvePermission()    → allow / ask / deny  │
│  6. executeTool(args, ctx) → result              │
│  7. recordTelemetry()      → audit record        │
│  8. firePostToolUseHooks() → modified result     │
│  9. formatResult()         → model-ready output  │
└─────────────────────────────────────────────────┘
```

### 步骤说明

| 步骤 | 职责 | 失败处理 |
|------|------|---------|
| 1. findTool | 在注册表中查找工具 | 返回 "unknown tool" 错误 |
| 2. validateInput | Zod schema 校验 | 返回校验错误给模型 |
| 3. customValidators | 自定义校验（路径安全、注入检测） | 返回校验错误 |
| 4. preHooks | 插件 pre-hook（Phase 6） | 可阻断执行 |
| 5. permission | 权限决策 | deny → 返回拒绝消息 |
| 6. execute | 真正执行工具逻辑 | 捕获异常，记录错误 |
| 7. telemetry | 记录执行数据 | 静默失败（不影响结果） |
| 8. postHooks | 插件 post-hook | 可修改结果 |
| 9. format | 格式化为模型可读输出 | 使用原始结果 |

## 3. 自定义校验器（Custom Validators）

### 3.1 需求

超越 Zod schema 的校验。Schema 只检查类型和结构，但无法检查语义安全性：

```typescript
// 路径安全校验器
function pathSanitizer(args: { path: string }) {
  if (args.path.includes("..")) {
    throw new Error("Path traversal detected")
  }
  if (args.path.startsWith("/etc") || args.path.startsWith("/root")) {
    throw new Error("Access to system directory denied")
  }
  return args
}

// 注入检测校验器
function bashInjectionDetector(args: { command: string }) {
  const dangerous = ["curl | sh", "eval(", "$(curl", "> /dev/"]
  for (const pattern of dangerous) {
    if (args.command.includes(pattern)) {
      throw new Error(`Potentially dangerous pattern: ${pattern}`)
    }
  }
  return args
}
```

### 3.2 注册方式

```typescript
// tool.ts
interface Tool.Info {
  // ...existing fields
  validators?: ((args: any) => any | Promise<any>)[]
}
```

校验器是可链式组合的函数——每个接收 args，返回 args（可能修改过）或抛出异常。

## 4. 遥测记录（Telemetry）

### 4.1 数据结构

```typescript
interface TelemetryRecord {
  tool: string          // 工具名称
  sessionID: string     // 会话 ID
  callID?: string       // 调用 ID
  args: any             // 输入参数
  duration: number      // 执行耗时（ms）
  status: "success" | "error" | "blocked"
  permission?: string   // 权限决策
  error?: string        // 错误消息
  timestamp: number     // 开始时间
}
```

### 4.2 缓冲与刷新

```python
telemetry_buffer = []

def record_telemetry(record):
    telemetry_buffer.append(record)
    log.info("telemetry", tool=record.tool, duration=record.duration)

    if len(telemetry_buffer) >= 50:
        flush_telemetry()

def flush_telemetry():
    flushed = telemetry_buffer.copy()
    telemetry_buffer.clear()
    # 可选：写入 SQLite 或文件
    return flushed
```

当前实现使用内存缓冲。未来可以扩展为写入 SQLite `tool_audit` 表。

## 5. 管线包装器

### 5.1 wrapExecute

核心函数，将原始 `execute` 包装为完整治理管线：

```typescript
function wrapExecute(
  toolId: string,
  originalExecute: (args: any, ctx: Context) => Promise<any>,
  validators?: ((args: any) => any | Promise<any>)[]
): (args: any, ctx: Context) => Promise<any> {
  return async (args, ctx) => {
    const startTime = Date.now()
    let status: "success" | "error" | "blocked" = "success"
    let error: string | undefined

    try {
      // Step 3: Custom validators
      const validatedArgs = await runValidators(validators, args)

      // Steps 4-6: 由调用方处理（hooks + permission + execute）
      const result = await originalExecute(validatedArgs, ctx)
      return result
    } catch (e: any) {
      status = "error"
      error = e.message ?? String(e)
      throw e
    } finally {
      // Step 7: Telemetry（无论成功失败都记录）
      recordTelemetry({
        tool: toolId,
        sessionID: ctx.sessionID,
        callID: ctx.callID,
        args,
        duration: Date.now() - startTime,
        status,
        error,
        timestamp: startTime
      })
    }
  }
}
```

### 5.2 关键设计决策

- Telemetry 在 `finally` 中记录——无论成功、失败、阻断都有记录
- Custom validators 在 pre-hooks 之前执行——先确保输入安全，再让插件修改
- wrapExecute 不改变工具的接口——对工具实现完全透明

## 6. 伪代码：完整流程

```python
async def full_governance_pipeline(tool_name, raw_args, ctx):
    # Step 1: Find tool
    tool = registry.find(tool_name)
    if not tool:
        return error_result(f"Unknown tool: {tool_name}")

    # Step 2: Schema validation (Zod)
    try:
        parsed_args = tool.schema.parse(raw_args)
    except ValidationError as e:
        return error_result(f"Invalid input: {e}")

    # Step 3: Custom validators
    try:
        validated_args = await run_validators(tool.validators, parsed_args)
    except Error as e:
        return error_result(f"Validation failed: {e}")

    # Step 4: Pre-hooks
    pre_result = await fire_pre_hooks(tool_name, validated_args, ctx)
    if pre_result.blocked:
        record_telemetry(tool_name, validated_args, "blocked", 0)
        return blocked_result(pre_result.block_reason)
    modified_args = pre_result.args

    # Step 5: Permission
    decision = await resolve_permission(tool_name, modified_args, ctx)
    if decision == "deny":
        record_telemetry(tool_name, modified_args, "blocked", 0)
        return denied_result()

    # Step 6: Execute
    start = now()
    try:
        result = await tool.execute(modified_args, ctx)
        duration = now() - start
    except Exception as e:
        duration = now() - start
        record_telemetry(tool_name, modified_args, "error", duration, error=str(e))
        raise

    # Step 7: Telemetry
    record_telemetry(tool_name, modified_args, "success", duration)

    # Step 8: Post-hooks
    final_result = await fire_post_hooks(tool_name, modified_args, result, ctx)

    # Step 9: Format
    return format_result(final_result)
```

## 7. 验收标准

- [ ] 每次工具调用都经过完整 8 步管线
- [ ] 自定义校验器能拦截危险参数
- [ ] Pre-hook 阻断时，工具不执行
- [ ] 每次工具调用都有 Telemetry 记录
- [ ] 失败的工具调用也有 Telemetry 记录
- [ ] `getTelemetry(sessionID)` 返回该会话的所有记录
- [ ] 缓冲区满时自动刷新

## 8. 源码位置

| 文件 | 职责 |
|------|------|
| `src/tool/governance.ts` | Governance 命名空间（完整管线） |
| `src/tool/tool.ts` | `validators` 字段定义 |
| `src/session/prompt.ts` | 工具执行时调用管线 |

## 9. 产品经理视角下的总需求句

> 工具系统必须从"可调用"升级到"可治理"——每次执行经过校验、Hook、权限、审计的完整链路，确保系统在赋予模型执行能力的同时，始终保持安全、可控、可追溯。
