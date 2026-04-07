# 05. Native Memory System

## 1. Why This Matters

Without persistent memory, an AI assistant is a stranger every session. The user must re-explain preferences, re-describe the project, re-correct the same mistakes. This is not just inconvenient — it fundamentally limits the assistant's ability to improve over time.

The memory system enables Aboocode to:
- Remember user preferences across sessions
- Learn from corrections and confirmations
- Understand project conventions without re-reading config files
- Carry reference knowledge forward

## 2. Four Memory Types

```
┌──────────────────────────────────────────────────────┐
│                    Memory System                       │
│                                                        │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │
│  │   User      │  │  Feedback   │  │    Project      │  │
│  │   Memory    │  │  Memory     │  │    Memory       │  │
│  │             │  │             │  │                 │  │
│  │ Preferences │  │ Corrections │  │ Conventions     │  │
│  │ Style       │  │ Confirmations│ │ Architecture    │  │
│  │ Identity    │  │ Patterns    │  │ Dependencies    │  │
│  └────────────┘  └────────────┘  └────────────────┘  │
│                                                        │
│  ┌────────────────────────────────────────────────┐   │
│  │                Reference Memory                  │   │
│  │                                                  │   │
│  │  External docs, API specs, domain knowledge     │   │
│  └────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

### 2.1 User Memory

Personal preferences and identity:
- "I prefer tabs over spaces"
- "Always use TypeScript strict mode"
- "My name is Steve"
- "I work at Company X"

### 2.2 Feedback Memory

Corrections and confirmations from the user. This is the learning loop:
- **Corrections**: "Don't use `var`, use `const`" — records What was wrong + Why + How to apply
- **Confirmations**: "Yes, that pattern is correct" — records What was confirmed + Context

The key insight is to record BOTH corrections AND confirmations. Corrections teach what to avoid; confirmations reinforce what works.

### 2.3 Project Memory

Project-specific conventions and architecture:
- "This project uses a monorepo with pnpm workspaces"
- "Auth is handled by the `@auth/core` package"
- "Tests go in `__tests__/` directories next to source files"

### 2.4 Reference Memory

External knowledge the model should carry:
- API documentation excerpts
- Domain-specific terminology
- Regulatory requirements

## 3. Storage Architecture

### 3.1 Directory Structure

```
~/.config/aboocode/projects/{cwd-hash}/memory/
  MEMORY.md              # Index file (max 200 lines, 25KB)
  user/
    preferences.md       # User preference entries
    identity.md          # User identity info
  feedback/
    corrections.md       # Correction entries with Why/How
    confirmations.md     # Confirmation entries
  project/
    conventions.md       # Project conventions
    architecture.md      # Architecture notes
  reference/
    api-docs.md          # Reference documents
    domain.md            # Domain knowledge
```

### 3.2 MEMORY.md Index File

The index file is the entry point loaded into the system prompt dynamic layer. It contains summaries and pointers to detailed memory files.

**Constraints:**
- Maximum 200 lines
- Maximum 25 KB
- When limits are exceeded, oldest entries are archived to individual files

### 3.3 Individual Memory File Format

Each memory file uses Markdown with YAML frontmatter:

```markdown
---
type: feedback
subtype: correction
created: 2026-04-08T10:30:00Z
session: sess_abc123
tags: [typescript, style]
---

## What was wrong
Used `interface` for a type alias that doesn't need declaration merging.

## Why
TypeScript `type` is preferred for simple aliases and unions.
`interface` should be reserved for object shapes that may be extended.

## How to apply
When defining a simple type alias or union, use `type`.
When defining an extendable object shape, use `interface`.
```

## 4. Memory Tools

### 4.1 MemoryWriteTool

```typescript
interface MemoryWriteInput {
  type: "user" | "feedback" | "project" | "reference"
  subtype?: string           // e.g., "correction", "confirmation", "preference"
  content: string            // The memory content (Markdown)
  tags?: string[]            // For searchability
}
```

### 4.2 MemoryReadTool

```typescript
interface MemoryReadInput {
  query?: string             // Search query
  type?: string              // Filter by type
  tags?: string[]            // Filter by tags
  limit?: number             // Max results (default: 10)
}
```

### 4.3 Pseudocode

```python
def memory_write(input):
    cwd_hash = hash_cwd(get_cwd())
    base_dir = f"~/.config/aboocode/projects/{cwd_hash}/memory"
    ensure_dir(base_dir)

    # Build frontmatter
    frontmatter = {
        "type": input.type,
        "subtype": input.subtype,
        "created": now().isoformat(),
        "session": current_session_id(),
        "tags": input.tags or [],
    }

    # Build content
    content = format_frontmatter(frontmatter) + "\n" + input.content

    # Write to type-specific file
    type_dir = f"{base_dir}/{input.type}"
    ensure_dir(type_dir)
    file_path = f"{type_dir}/{input.subtype or 'general'}.md"
    append_to_file(file_path, content + "\n\n---\n\n")

    # Update MEMORY.md index
    update_memory_index(base_dir, input)

    return { success: True, path: file_path }

def memory_read(input):
    cwd_hash = hash_cwd(get_cwd())
    base_dir = f"~/.config/aboocode/projects/{cwd_hash}/memory"

    if input.query:
        return search_memory_files(base_dir, input.query, input.limit)
    elif input.type:
        return read_memory_type(base_dir, input.type, input.limit)
    else:
        return read_memory_index(base_dir)

def update_memory_index(base_dir, input):
    index_path = f"{base_dir}/MEMORY.md"
    index = read_file(index_path) if exists(index_path) else ""

    # Add summary entry
    summary = f"- [{input.type}] {truncate(input.content, 80)}"
    index = summary + "\n" + index

    # Enforce limits
    lines = index.split("\n")
    if len(lines) > 200:
        lines = lines[:200]  # Keep most recent
    if len("\n".join(lines)) > 25000:
        lines = lines[:150]  # Aggressive trim

    write_file(index_path, "\n".join(lines))
```

## 5. Feedback Memory: Why/How Structure

The feedback memory type has a specific structure designed for learning:

### 5.1 Correction Entry

```markdown
## What was wrong
[Description of the incorrect behavior]

## Why
[Explanation of why it was wrong]

## How to apply
[Concrete instructions for future behavior]
```

### 5.2 Confirmation Entry

```markdown
## What was confirmed
[Description of the correct behavior]

## Context
[When and why this pattern is appropriate]
```

### 5.3 Why Record Confirmations

Most systems only record errors. But confirmations are equally valuable:
- They reinforce good patterns
- They disambiguate cases where multiple approaches are valid
- They build confidence in specific solutions for this project

## 6. Memory Context Loading

### 6.1 Integration with System Prompt

The memory system integrates with the dynamic layer (Phase 1):

```python
def load_memory_context(cwd):
    cwd_hash = hash_cwd(cwd)
    index_path = f"~/.config/aboocode/projects/{cwd_hash}/memory/MEMORY.md"

    if not exists(index_path):
        return None

    content = read_file(index_path)
    if not content.strip():
        return None

    return f"<memory>\n{content}\n</memory>"
```

### 6.2 Token Budget

Memory context is part of the dynamic layer and counts toward the token budget. The 25KB / 200-line limit on MEMORY.md ensures memory never exceeds approximately 6,000 tokens.

## 7. Acceptance Criteria

- [ ] `MemoryWriteTool` creates entries with correct frontmatter in the appropriate type directory
- [ ] `MemoryReadTool` returns relevant memories filtered by type, tags, or search query
- [ ] MEMORY.md index never exceeds 200 lines or 25 KB
- [ ] Feedback corrections include What/Why/How structure
- [ ] Feedback confirmations include What/Context structure
- [ ] Memory persists across sessions (written to disk, not in-memory only)
- [ ] Memory context is loaded into the system prompt dynamic layer
- [ ] Different projects (different cwd) have separate memory stores
- [ ] Memory tools are excluded from micro-compaction (results are not clearable)

## 8. Source Files

| File | Responsibility |
|------|------|
| `src/memory/memory.ts` | Core memory read/write operations |
| `src/memory/context.ts` | Load memory context for system prompt |
| `src/tool/memory-read.ts` | MemoryReadTool definition |
| `src/tool/memory-write.ts` | MemoryWriteTool definition |
| `src/session/system.ts` | Integrates memory context into dynamic layer |

## 9. Product Manager Summary

> An AI assistant that doesn't remember who the user is or what mistakes it made feels like meeting a stranger every time — the memory system enables Aboocode to accumulate understanding across sessions.
