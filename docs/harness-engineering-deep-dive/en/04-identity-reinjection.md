# 04. Identity Re-injection After Compaction

## 1. Why This Matters

When proactive compaction (Phase 0, Layer 2) replaces the full conversation history with a summary, the model loses critical context about itself:
- Which agent role it is playing (main, background, verifier)
- What its current task description is
- What the current working directory is
- What constraints apply to its behavior

Without re-injection, the model after compaction behaves like a freshly started session — it may hallucinate a different role, forget file locations, or ignore task-specific constraints. This is the "post-compaction amnesia" problem.

## 2. The Post-Compaction Amnesia Problem

```
Before Compaction:
  msg[0]: system prompt (with agent identity)
  msg[1]: user: "Refactor the auth module"
  msg[2]: assistant: reads files, understands codebase
  msg[3-50]: tool calls, reasoning, partial progress
  
After Compaction (without identity re-injection):
  msg[0]: system prompt (with agent identity)
  msg[1]: summary: "The agent was refactoring auth module..."
  
  Problem: The model sees a third-person summary about "the agent"
  but has no first-person awareness that IT is that agent.
  It may ask "What would you like me to do?" instead of continuing.
```

## 3. IdentityContext Data Structure

### 3.1 Definition

```typescript
interface IdentityContext {
  agentName: string          // e.g., "main", "background-1", "verifier"
  agentDescription: string   // e.g., "Primary engineering assistant"
  cwd: string                // Current working directory
  activeTask?: string        // Current task description (if any)
  constraints?: string[]     // Role-specific constraints
  sessionId: string          // For cross-reference
}
```

### 3.2 Key Design Principle

**Identity is deterministic, not generative.**

The IdentityContext is constructed from configuration and session state — NOT from LLM output. This prevents the model from drifting its own identity over multiple compaction cycles.

```
CORRECT:  identity.agentName = config.agent.name       // From config
WRONG:    identity.agentName = llm.extract("who are you?")  // From model
```

## 4. Identity Injection Mechanism

### 4.1 Where It Is Injected

Identity is injected into the **dynamic layer** of the system prompt (Phase 1) as an XML block:

```xml
<identity>
You are currently operating as: main
Description: Primary engineering assistant for the user's project
Working directory: /Users/dev/my-project
Active task: Refactoring the authentication module to use JWT tokens
Constraints:
- You have full read/write access to the workspace
- You must run tests after modifying source files
</identity>
```

### 4.2 Injection Lifecycle

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Compaction      │────▶│  Set Identity    │────▶│  Next LLM Call   │
│  completes       │     │  Context         │     │  includes        │
│                  │     │                  │     │  <identity> block │
└─────────────────┘     └──────────────────┘     └────────┬─────────┘
                                                          │
                                                          ▼
                                                 ┌──────────────────┐
                                                 │  LLM responds     │
                                                 │  with role        │
                                                 │  awareness        │
                                                 └────────┬─────────┘
                                                          │
                                                          ▼
                                                 ┌──────────────────┐
                                                 │  Clear Identity   │
                                                 │  Context          │
                                                 │  (one-time use)   │
                                                 └──────────────────┘
```

### 4.3 One-Time Injection

The identity block is injected into the dynamic layer only for the **first LLM call after compaction**. Once the LLM successfully responds (indicating it has absorbed the identity), the identity context is cleared to avoid wasting tokens on subsequent calls.

## 5. Pseudocode

### 5.1 Setting Identity After Compaction

```python
def set_post_compaction_identity(session_id):
    agent = get_current_agent(session_id)
    session = get_session(session_id)

    identity = IdentityContext(
        agentName=agent.name,
        agentDescription=agent.description,
        cwd=session.cwd,
        activeTask=session.current_task,
        constraints=agent.constraints,
        sessionId=session_id,
    )

    store.set(f"identity:{session_id}", identity)
```

### 5.2 Injecting Identity into Dynamic Layer

```python
def build_dynamic_layer(session):
    parts = []

    # ... other dynamic parts ...

    # Identity re-injection (Phase 3)
    identity = store.get(f"identity:{session.id}")
    if identity:
        parts.append(format_identity_xml(identity))

    return "\n\n".join(parts)

def format_identity_xml(identity):
    lines = [
        "<identity>",
        f"You are currently operating as: {identity.agentName}",
        f"Description: {identity.agentDescription}",
        f"Working directory: {identity.cwd}",
    ]
    if identity.activeTask:
        lines.append(f"Active task: {identity.activeTask}")
    if identity.constraints:
        lines.append("Constraints:")
        for c in identity.constraints:
            lines.append(f"- {c}")
    lines.append("</identity>")
    return "\n".join(lines)
```

### 5.3 Clearing Identity After Successful Response

```python
def on_llm_response_success(session_id):
    identity = store.get(f"identity:{session_id}")
    if identity:
        store.delete(f"identity:{session_id}")
        log.info(f"Identity context cleared for session {session_id}")
```

## 6. Agent-Specific Identity Examples

### 6.1 Main Agent

```xml
<identity>
You are currently operating as: main
Description: Primary engineering assistant
Working directory: /Users/dev/my-project
Active task: Implementing user authentication with OAuth2
Constraints:
- Full read/write access
- Must run tests after code changes
</identity>
```

### 6.2 Background Agent

```xml
<identity>
You are currently operating as: background-task-1
Description: Background task executor running tests
Working directory: /tmp/aboocode-worktree-abc123
Active task: Running the full test suite while main agent continues coding
Constraints:
- Operating in a git worktree (isolated from main workspace)
- Results will be reported back to the main agent
</identity>
```

### 6.3 Verification Agent

```xml
<identity>
You are currently operating as: verifier
Description: Independent read-only verification agent
Working directory: /Users/dev/my-project
Active task: Verifying that the auth module refactoring passes all tests
Constraints:
- READ-ONLY: You cannot use write, edit, or apply_patch tools
- You must verify through observation and read-only commands only
- Report findings as PASS, FAIL, or PARTIAL
</identity>
```

## 7. Acceptance Criteria

- [ ] After proactive compaction, the next LLM call includes an `<identity>` block in the dynamic layer
- [ ] The identity block contains agent name, description, cwd, and active task
- [ ] Identity context is cleared after the first successful LLM response post-compaction
- [ ] Identity is derived from configuration/session state, never from LLM output
- [ ] Multiple compactions in one session each trigger a fresh identity injection
- [ ] Background and verifier agents receive role-appropriate identity blocks
- [ ] The model resumes its task coherently after compaction (does not ask "What should I do?")

## 8. Source Files

| File | Responsibility |
|------|------|
| `src/session/compaction.ts` | Calls set_post_compaction_identity after compaction |
| `src/session/prompt.ts` | Injects identity block into dynamic layer, clears after use |

## 9. Product Manager Summary

> Compaction should not cause amnesia — the system must proactively re-inject identity and task context after compaction to ensure seamless continuation.
