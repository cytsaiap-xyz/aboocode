# 10. Tool Governance Pipeline

## 1. Why This Matters

In a naive agent, tools are simply called — the model says "run bash" and the system runs bash. There is no validation, no permission check, no audit trail, no hook intervention. This is like giving root access to every process in an operating system.

Tool governance transforms tool execution from "callable" to "governable" — every tool invocation passes through an 8-step pipeline that validates, authorizes, audits, and allows external intervention.

## 2. The 8-Step Execution Pipeline

```
Step 1: findTool
  │  Look up tool in registry by name
  ▼
Step 2: validateInput (Zod)
  │  Validate arguments against tool's Zod schema
  ▼
Step 3: runCustomValidators
  │  Tool-specific validation (path sanitization, injection detection)
  ▼
Step 4: firePreHooks
  │  tool.execute.before hooks (can block or modify args)
  ▼
Step 5: resolvePermission
  │  Check permission level (auto-allow, ask-user, deny)
  ▼
Step 6: executeTool
  │  Run the actual tool implementation
  ▼
Step 7: recordTelemetry
  │  Log execution metrics (duration, success, tokens)
  ▼
Step 8: firePostHooks + formatResult
     tool.execute.after hooks (can modify result)
     Format result for model consumption
```

## 3. Step-by-Step Detail

### 3.1 Step 1: findTool

```python
def find_tool(name):
    tool = registry.get(name)
    if not tool:
        # Check deferred tools (Phase 7)
        if name in registry.deferred_names:
            raise ToolNotLoadedError(
                f"Tool '{name}' is deferred. Use ToolSearch to load it first."
            )
        raise ToolNotFoundError(f"Unknown tool: {name}")
    return tool
```

### 3.2 Step 2: validateInput (Zod)

Every tool defines its input schema using Zod. The governance pipeline validates the model's arguments against this schema before execution:

```python
def validate_input(tool, args):
    try:
        validated = tool.input_schema.parse(args)
        return validated
    except ZodError as e:
        raise ToolInputError(
            tool=tool.name,
            errors=e.errors,
            message=f"Invalid arguments for {tool.name}: {format_zod_errors(e)}"
        )
```

### 3.3 Step 3: runCustomValidators

Tools can register custom validators for domain-specific checks:

```python
def run_custom_validators(tool, args):
    for validator in tool.custom_validators:
        result = validator(args)
        if not result.valid:
            raise ToolValidationError(
                tool=tool.name,
                validator=validator.name,
                message=result.message,
            )
```

**Path Sanitization Example:**
```python
def path_sanitizer(args):
    path = args.get("file_path", "")

    # Block path traversal
    if ".." in path:
        return ValidationResult(valid=False, message="Path traversal detected")

    # Block access outside workspace
    if not path.startswith(workspace_root):
        return ValidationResult(valid=False, message="Path outside workspace")

    return ValidationResult(valid=True)
```

**Injection Detection Example:**
```python
def bash_injection_detector(args):
    command = args.get("command", "")

    # Detect common injection patterns
    dangerous_patterns = [
        r";\s*rm\s+-rf\s+/",      # rm -rf /
        r"\|\s*sh\b",              # pipe to sh
        r"curl.*\|\s*bash",        # curl | bash
        r">\s*/etc/",              # write to /etc
    ]

    for pattern in dangerous_patterns:
        if re.search(pattern, command):
            return ValidationResult(
                valid=False,
                message=f"Potentially dangerous command pattern detected: {pattern}"
            )

    return ValidationResult(valid=True)
```

### 3.4 Step 4: firePreHooks

Delegates to the hook engine (Phase 6):

```python
def fire_pre_hooks(tool, args, call_id):
    result = hook_engine.fire("tool.execute.before", {
        toolName: tool.name,
        args: args,
        callId: call_id,
    })

    if result.blocked:
        raise ToolBlockedByHookError(
            tool=tool.name,
            reason=result.reason,
            blockedBy=result.blockedBy,
        )

    # Return potentially modified args
    return result.data.get("args", args)
```

### 3.5 Step 5: resolvePermission

```python
def resolve_permission(tool, args):
    # Check tool.permission.check hooks first
    hook_result = hook_engine.fire("tool.permission.check", {
        toolName: tool.name,
        args: args,
        currentPermission: tool.default_permission,
    })

    if hook_result.blocked:
        raise PermissionDeniedError(tool=tool.name, reason=hook_result.reason)

    permission = hook_result.data.get("currentPermission", tool.default_permission)

    if permission == "auto":
        return  # Proceed
    elif permission == "ask":
        approved = await ask_user_permission(tool.name, args)
        if not approved:
            raise PermissionDeniedError(tool=tool.name, reason="User denied")
    elif permission == "deny":
        raise PermissionDeniedError(tool=tool.name, reason="Tool denied by policy")
```

### 3.6 Step 6: executeTool

```python
def execute_tool(tool, validated_args):
    start_time = now()
    try:
        result = await tool.execute(validated_args)
        return ToolExecution(
            success=True,
            result=result,
            durationMs=elapsed(start_time),
        )
    except Exception as e:
        return ToolExecution(
            success=False,
            error=e,
            durationMs=elapsed(start_time),
        )
```

### 3.7 Step 7: recordTelemetry

```python
def record_telemetry(tool, execution, args):
    record = TelemetryRecord(
        toolName=tool.name,
        callId=execution.callId,
        sessionId=current_session_id(),
        timestamp=now(),
        durationMs=execution.durationMs,
        success=execution.success,
        inputTokenEstimate=estimate_tokens(args),
        outputTokenEstimate=estimate_tokens(execution.result),
        error=str(execution.error) if execution.error else None,
    )

    telemetry_buffer.add(record)

    # Flush buffer when it reaches 50 records
    if telemetry_buffer.size >= 50:
        telemetry_buffer.flush()
```

### 3.8 Step 8: firePostHooks + formatResult

```python
def fire_post_hooks_and_format(tool, args, execution):
    hook_result = hook_engine.fire("tool.execute.after", {
        toolName: tool.name,
        args: args,
        result: execution.result,
        durationMs: execution.durationMs,
    })

    final_result = hook_result.data.get("result", execution.result)
    return format_tool_result(tool.name, final_result)
```

## 4. wrapExecute: Transparent Governance

The governance pipeline wraps the original tool execute function transparently:

```python
def wrap_execute(tool):
    original_execute = tool.execute

    async def governed_execute(args):
        call_id = generate_call_id()

        # Steps 1-3: Already handled before this point
        validated_args = validate_input(tool, args)
        run_custom_validators(tool, validated_args)

        # Step 4: Pre-hooks (may modify args)
        hooked_args = fire_pre_hooks(tool, validated_args, call_id)

        # Step 5: Permission
        resolve_permission(tool, hooked_args)

        # Step 6: Execute
        execution = await execute_tool(tool, hooked_args)

        # Step 7: Telemetry
        record_telemetry(tool, execution, hooked_args)

        # Step 8: Post-hooks + format
        return fire_post_hooks_and_format(tool, hooked_args, execution)

    tool.execute = governed_execute
    return tool
```

The tool itself is unaware of governance — its execute function is replaced with the governed version at registration time.

## 5. Telemetry Buffer

### 5.1 Data Structure

```typescript
interface TelemetryRecord {
  toolName: string
  callId: string
  sessionId: string
  timestamp: string
  durationMs: number
  success: boolean
  inputTokenEstimate: number
  outputTokenEstimate: number
  error?: string
}

class TelemetryBuffer {
  private records: TelemetryRecord[] = []
  private readonly flushThreshold = 50

  add(record: TelemetryRecord): void {
    this.records.push(record)
    if (this.records.length >= this.flushThreshold) {
      this.flush()
    }
  }

  flush(): void {
    if (this.records.length === 0) return
    const batch = this.records.splice(0)
    // Write to telemetry store (SQLite or file)
    telemetryStore.writeBatch(batch)
  }
}
```

## 6. Acceptance Criteria

- [ ] Every tool call passes through all 8 pipeline steps in order
- [ ] Invalid tool arguments (failing Zod validation) return a clear error to the model
- [ ] Path traversal attempts are caught by custom validators
- [ ] Pre-hooks can block tool execution
- [ ] Pre-hooks can modify tool arguments (model sees modified result)
- [ ] Permission denied returns an informative error to the model
- [ ] Telemetry records are buffered and flushed at 50 records
- [ ] Post-hooks can modify tool results
- [ ] wrapExecute is transparent — the tool implementation is unmodified
- [ ] A tool not in the registry returns a ToolNotFoundError

## 7. Source Files

| File | Responsibility |
|------|------|
| `src/tool/governance.ts` | 8-step pipeline, wrapExecute, custom validators |
| `src/tool/tool.ts` | Tool definitions, Zod schemas, permission levels |
| `src/session/prompt.ts` | Integrates governed tools into the session loop |

## 8. Product Manager Summary

> The tool system must upgrade from "callable" to "governable" — every execution passes through validation, hooks, permissions, and audit.
