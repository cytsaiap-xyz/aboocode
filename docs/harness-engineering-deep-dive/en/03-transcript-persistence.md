# 03. Transcript Persistence

## 1. Why This Matters

Context compaction (Phase 0) is essential to keep conversations within the token budget, but it destroys the original conversation content. Without persistence, compacted messages are lost forever — no audit trail, no recovery, no ability to replay or debug what happened.

The transcript persistence layer ensures that every message is archived to disk before compaction, providing:
- Full audit trail of all agent actions
- Ability to recover context after crashes
- Post-session analysis and debugging
- Compliance and accountability records

## 2. Architecture

```
┌──────────────────────────────────────────────────┐
│ Session (in-memory messages)                       │
│                                                    │
│   msg1 → msg2 → msg3 → ... → msgN                │
│                                                    │
│   ┌──────────────────┐                            │
│   │ Compaction Trigger │                           │
│   │ (80% threshold)   │                            │
│   └────────┬─────────┘                            │
│            │                                       │
│            ▼                                       │
│   ┌──────────────────┐    ┌────────────────────┐  │
│   │ transcript.save() │───▶│ Disk (JSONL file) │  │
│   └──────────────────┘    └────────────────────┘  │
│            │                                       │
│            ▼                                       │
│   ┌──────────────────┐                            │
│   │ LLM Summarization │                            │
│   └──────────────────┘                            │
│            │                                       │
│            ▼                                       │
│   ┌──────────────────┐                            │
│   │ Replace messages   │                           │
│   │ with summary       │                           │
│   └──────────────────┘                            │
└──────────────────────────────────────────────────┘
```

**Critical ordering**: The transcript MUST be saved BEFORE the LLM summarization step. If summarization fails or the process crashes during compaction, the original messages are already safely on disk.

## 3. Storage Format: JSONL

### 3.1 Requirement

Each message is stored as one JSON object per line in a `.jsonl` file. JSONL (JSON Lines) is chosen over a single JSON array because:
- Append-only writes (no need to parse the entire file to add a message)
- Streaming-friendly (can read line by line)
- Corruption-resistant (a corrupted line does not invalidate the rest)

### 3.2 File Path Convention

```
~/.local/share/aboocode/transcripts/{sessionID}/{timestamp}.jsonl
```

Example:
```
~/.local/share/aboocode/transcripts/
  sess_abc123/
    2026-04-08T10-30-00.jsonl    # First compaction
    2026-04-08T11-15-22.jsonl    # Second compaction
  sess_def456/
    2026-04-08T14-00-00.jsonl
```

### 3.3 Message Format

Each line contains a complete message object:

```json
{"role":"user","content":"Find all TypeScript files with TODO comments","timestamp":"2026-04-08T10:30:01Z"}
{"role":"assistant","content":"I'll search for TODO comments...","parts":[{"type":"tool_call","tool":"grep","args":{"pattern":"TODO","type":"ts"}}],"timestamp":"2026-04-08T10:30:02Z"}
{"role":"tool","content":"Found 15 matches in 8 files...","toolName":"grep","toolCallId":"call_001","timestamp":"2026-04-08T10:30:03Z"}
```

## 4. Transcript Namespace API

### 4.1 Interface

```typescript
namespace Transcript {
  // Save all current messages to a new JSONL file
  function save(sessionId: string, messages: Message[]): string  // returns file path

  // Load messages from a specific transcript file
  function load(filePath: string): Message[]

  // List all transcript files for a session, sorted by timestamp
  function list(sessionId: string): TranscriptFile[]
}

interface TranscriptFile {
  path: string
  sessionId: string
  timestamp: Date
  messageCount: number
  sizeBytes: number
}
```

### 4.2 Pseudocode

```python
def transcript_save(session_id, messages):
    dir = ensure_dir(f"~/.local/share/aboocode/transcripts/{session_id}")
    timestamp = now().format("YYYY-MM-DDTHH-mm-ss")
    path = f"{dir}/{timestamp}.jsonl"

    with open(path, "w") as f:
        for msg in messages:
            line = json.dumps(serialize_message(msg))
            f.write(line + "\n")

    return path

def transcript_load(file_path):
    messages = []
    with open(file_path, "r") as f:
        for line in f:
            line = line.strip()
            if line:
                messages.append(deserialize_message(json.loads(line)))
    return messages

def transcript_list(session_id):
    dir = f"~/.local/share/aboocode/transcripts/{session_id}"
    if not exists(dir):
        return []

    files = glob(f"{dir}/*.jsonl")
    return sorted([
        TranscriptFile(
            path=f,
            sessionId=session_id,
            timestamp=parse_timestamp(basename(f)),
            messageCount=count_lines(f),
            sizeBytes=file_size(f),
        )
        for f in files
    ], key=lambda t: t.timestamp)
```

## 5. Integration with Compaction

The compaction system (Phase 0) calls `transcript.save()` as its very first step:

```python
def proactive_compact(session_id):
    messages = get_messages(session_id)

    # STEP 1: Save transcript BEFORE any modification
    transcript_path = transcript.save(session_id, messages)
    log.info(f"Transcript saved: {transcript_path}")

    # STEP 2: Now safe to summarize and replace
    summary = llm.summarize(messages)
    replace_messages(session_id, [summary_message(summary)])
    inject_identity(session_id)
```

## 6. Storage Sizing

### 6.1 Typical Session Estimates

| Session Profile | Turns | Estimated JSONL Size |
|------|------|------|
| Quick task (5-10 tool calls) | 20-30 | 50-100 KB |
| Medium session (20-40 tool calls) | 60-100 | 200-500 KB |
| Long session (80+ tool calls) | 200+ | 1-3 MB |

A typical 100-turn session produces 200-500 KB of JSONL data.

### 6.2 Cleanup Policy

Currently, there is no automatic cleanup policy. Transcript files accumulate on disk. Future considerations:
- Time-based cleanup (delete transcripts older than 30 days)
- Size-based cleanup (keep total under 1 GB)
- User-initiated cleanup via CLI command
- Compression (gzip older transcripts)

## 7. Data Structures

```typescript
interface TranscriptMessage {
  role: "user" | "assistant" | "tool" | "system"
  content: string
  timestamp: string              // ISO 8601
  parts?: MessagePart[]          // Tool calls, results
  toolName?: string              // For tool role
  toolCallId?: string            // For tool role
  metadata?: Record<string, unknown>
}

interface TranscriptIndex {
  sessionId: string
  files: TranscriptFile[]
  totalMessages: number
  totalSizeBytes: number
}
```

## 8. Acceptance Criteria

- [ ] Full conversation is saved to disk BEFORE compaction summarization begins
- [ ] Each message occupies exactly one line in the JSONL file
- [ ] Transcript files are stored at `~/.local/share/aboocode/transcripts/{sessionID}/{timestamp}.jsonl`
- [ ] `transcript.load()` correctly reconstructs all messages from a JSONL file
- [ ] `transcript.list()` returns files sorted by timestamp (oldest first)
- [ ] A corrupted line in JSONL does not prevent reading other lines
- [ ] Multiple compactions in one session create multiple transcript files
- [ ] Transcript save completes even if the session crashes during compaction

## 9. Source Files

| File | Responsibility |
|------|------|
| `src/session/transcript.ts` | Transcript namespace: save, load, list |
| `src/session/compaction.ts` | Calls transcript.save() before summarization |

## 10. Product Manager Summary

> Compaction is necessary, but losing the original conversation is unacceptable — the system must archive the full conversation to disk before compaction, ensuring context control while preserving audit and recovery capabilities.
