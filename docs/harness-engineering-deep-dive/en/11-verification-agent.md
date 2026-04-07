# 11. Verification Agent

## 1. Why This Matters

Self-verification is fundamentally unreliable. When the same agent that wrote code also checks it, confirmation bias is inevitable — the agent "knows" what it intended, so it sees what it expects rather than what is actually there. This is analogous to why code review exists in software engineering: the author should not be the sole reviewer.

The Verification Agent is an independent, read-only agent that checks the implementer's work through actual command execution. It cannot modify files, only observe and report.

## 2. Core Principle: Verifier Is Not the Implementer

```
Main Agent (implementer)          Verification Agent (verifier)
  |                                  |
  | writes code                      | reads code
  | edits files                      | runs tests
  | applies patches                  | checks output
  | creates files                    | reports PASS/FAIL
  |                                  |
  | CAN: write, edit, bash,         | CAN: read, grep, glob, bash (read-only)
  |      apply_patch, etc.           | CANNOT: write, edit, apply_patch
  |                                  |
  | Perspective: "I built this"      | Perspective: "Does this actually work?"
```

## 3. Verify Agent Configuration

### 3.1 Agent Definition

```typescript
interface VerifyAgentConfig {
  mode: "subagent"               // Runs as a subagent, not the main agent
  name: "verifier"
  description: "Independent read-only verification agent"
  readOnly: true                 // Enforced at the tool level
  allowedTools: [
    "read",                      // Read file contents
    "grep",                      // Search file contents
    "glob",                      // Find files by pattern
    "bash",                      // Run commands (for tests, linters)
    "codesearch",                // Semantic code search
  ]
  deniedTools: [
    "write",                     // Cannot create/overwrite files
    "edit",                      // Cannot modify files
    "apply_patch",               // Cannot apply patches
    "memory-write",              // Cannot modify memory
    "task",                      // Cannot create subtasks
  ]
}
```

### 3.2 Read-Only Enforcement

The read-only constraint is enforced at the tool governance level (Phase 9), not by trusting the model to obey instructions:

```python
def enforce_readonly(agent, tool_call):
    if agent.readOnly and tool_call.name in WRITE_TOOLS:
        raise ReadOnlyWorkspaceError(
            agent=agent.name,
            tool=tool_call.name,
            message=f"Verification agent cannot use write tool: {tool_call.name}"
        )
```

This means even if the model hallucinates a write tool call, the system blocks it.

## 4. VerifyTool Interface

### 4.1 Tool Definition

The main agent invokes verification through the `verify` tool:

```typescript
interface VerifyToolInput {
  description: string            // What to verify
  checks?: VerifyCheck[]         // Optional specific checks to run
}

interface VerifyCheck {
  name: string                   // Check name (e.g., "tests_pass")
  command?: string               // Specific command to run
  expectation?: string           // What the check should confirm
}
```

### 4.2 Example Invocations

**Basic verification:**
```json
{
  "description": "Verify that the auth module refactoring is complete and correct"
}
```

**With specific checks:**
```json
{
  "description": "Verify the JWT implementation",
  "checks": [
    {
      "name": "tests_pass",
      "command": "npm test -- --filter auth",
      "expectation": "All auth-related tests pass"
    },
    {
      "name": "no_hardcoded_secrets",
      "command": "grep -r 'secret\\|password\\|key' src/auth/",
      "expectation": "No hardcoded secrets in auth module"
    },
    {
      "name": "types_check",
      "command": "npx tsc --noEmit",
      "expectation": "No TypeScript type errors"
    }
  ]
}
```

## 5. Verification Report Format

### 5.1 Structure

```typescript
interface VerifyReport {
  status: "PASS" | "FAIL" | "PARTIAL"
  description: string
  checks: CheckResult[]
  summary: string
  evidence: string[]             // Command outputs that support the verdict
}

interface CheckResult {
  name: string
  status: "PASS" | "FAIL" | "SKIP"
  output: string                 // Actual command output
  notes?: string                 // Verifier's observations
}
```

### 5.2 Report Examples

**PASS Report:**
```
Verification Status: PASS

Description: JWT implementation verification

Checks:
  [PASS] tests_pass
    Output: 24 tests passed, 0 failed
    
  [PASS] no_hardcoded_secrets
    Output: No matches found
    
  [PASS] types_check
    Output: No errors found

Summary: All checks passed. The JWT implementation is correctly
integrated with the existing auth module. Token generation,
validation, and refresh flows are covered by tests.
```

**FAIL Report:**
```
Verification Status: FAIL

Description: JWT implementation verification

Checks:
  [PASS] tests_pass
    Output: 24 tests passed, 0 failed
    
  [FAIL] no_hardcoded_secrets
    Output: src/auth/config.ts:12: const JWT_SECRET = "dev-secret-key"
    Notes: Hardcoded JWT secret found. Should use environment variable.
    
  [PASS] types_check
    Output: No errors found

Summary: Tests pass and types check, but a hardcoded JWT secret
was found in src/auth/config.ts. This is a security issue that
must be fixed before the implementation is considered complete.

Evidence:
  - grep output showing hardcoded secret at src/auth/config.ts:12
```

## 6. Pseudocode

### 6.1 VerifyTool Execution

```python
async def verify_execute(input):
    # Create verification agent as subagent
    verify_agent = create_agent(VerifyAgentConfig)

    # Build verification prompt
    prompt = build_verify_prompt(input.description, input.checks)

    # Run verification agent (read-only, isolated)
    result = await run_subagent(
        agent=verify_agent,
        prompt=prompt,
        workspace=current_workspace(),  # Same workspace, but read-only
        isolation="readonly",            # Phase 11 isolation level
    )

    # Parse report from agent output
    report = parse_verify_report(result.output)

    return format_verify_result(report)

def build_verify_prompt(description, checks):
    prompt = f"You are a verification agent. Your task:\n{description}\n\n"

    if checks:
        prompt += "Run these specific checks:\n"
        for check in checks:
            prompt += f"- {check.name}"
            if check.command:
                prompt += f": run `{check.command}`"
            if check.expectation:
                prompt += f" (expect: {check.expectation})"
            prompt += "\n"

    prompt += (
        "\nReport your findings as PASS, FAIL, or PARTIAL.\n"
        "Include command output as evidence.\n"
        "You CANNOT modify any files. Only read and run commands."
    )

    return prompt
```

## 7. Suggested Use Cases

The verification agent is most valuable for:

| Scenario | Why Verification Helps |
|----------|----------------------|
| Complex multi-file refactoring | Catches files that were missed or incorrectly updated |
| Bug fixes | Confirms the bug is actually fixed, not just masked |
| Security-sensitive changes | Independent check for secrets, permissions, injection vectors |
| API contract changes | Verifies backward compatibility |
| Database migration | Confirms schema changes are reversible and data-safe |
| Dependency updates | Checks for breaking changes in downstream code |

## 8. Acceptance Criteria

- [ ] Verification agent runs as a subagent with mode=subagent
- [ ] Verification agent is read-only: write, edit, apply_patch tools are blocked at the governance level
- [ ] Blocked write attempts return ReadOnlyWorkspaceError (not silent failure)
- [ ] VerifyTool accepts a description and optional checks array
- [ ] Verification report includes PASS/FAIL/PARTIAL status
- [ ] Report includes command output as evidence
- [ ] Verification agent can run bash commands (for tests, linters)
- [ ] Verification agent operates on the same workspace as the main agent (read-only view)
- [ ] Main agent receives the verification report as a tool result

## 9. Source Files

| File | Responsibility |
|------|------|
| `src/tool/verify.ts` | VerifyTool definition and execution |
| `src/agent/agent.ts` | Agent creation with readOnly flag |
| `src/agent/prompt/verify.txt` | Verification agent system prompt template |

## 10. Product Manager Summary

> Self-verification is unreliable — the system needs an independent, read-only verification role that checks results through actual command execution.
