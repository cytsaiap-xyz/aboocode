# aboocode

AI-powered development tool for the terminal with multi-agent team collaboration and persistent memory.

## Install

```bash
npm install
```

## Usage

```bash
# Run with a prompt
aboo run "your prompt here"

# Run with a specific agent
aboo run --agent orchestrator "build a web app with a team"

# Run with a specific model
aboo run --model openrouter/stepfun/step-3.5-flash:free "your prompt"
```

## Development

```bash
# Run in dev mode
npm run dev

# Build
npm run build

# Run tests
npm test

# Type check
npm run typecheck
```

## Configuration

Create an `aboocode.json` in your project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "openrouter",
      "options": {
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKey": "your-api-key"
      },
      "models": {
        "stepfun/step-3.5-flash:free": {
          "name": "Step Fun"
        }
      }
    }
  }
}
```

## Features

### Agent Team System

The orchestrator agent can create and manage teams of specialized agents:

- **plan_team** — initialize team planning for a task
- **add_agent** — create specialized agents with custom prompts
- **finalize_team** — lock in the team roster (requires 2+ agents)
- **delegate_task** — assign work to a specific agent (sequential)
- **delegate_tasks** — assign work to multiple agents (parallel with dependency support)
- **discuss** — moderated multi-agent discussion
- **disband_team** — clean up agents when done

### Memory System

Persistent memory across sessions via MEMORY.md:

- Auto-extracts key patterns and decisions from conversations
- Injects relevant context into new sessions
- Stored per-project in `~/.local/share/aboocode/memory/`

### Debug Logging

Team and memory operations are logged to `~/.local/share/aboocode/log/debug-team-memory.log` for diagnostics.

## E2E Tests

```bash
# Test team and memory system
bash packages/aboocode/script/test-team-memory.sh

# Test team workflow + memory extraction
bash packages/aboocode/test/e2e/test-team-memory.sh

# Test memory with game building
bash packages/aboocode/test/e2e/test-memory-game.sh
```

## License

MIT
