# Plan: Turn Aboocode into a Full VS Code Extension

## Current State

The existing VS Code extension (`sdks/vscode/`) is minimal — it only:
- Opens an aboocode CLI process in a VS Code terminal panel
- Sends file references to the CLI via an HTTP endpoint (`/tui/append-prompt`)
- Has 3 commands: open terminal, open new terminal, add filepath

The core aboocode server already exposes a rich REST API (sessions, files, config, events via SSE, etc.) that the extension can leverage directly.

---

## Goal

Transform aboocode from a "terminal wrapper" extension into a **native VS Code extension** with an integrated chat panel, inline code actions, diagnostics integration, and full session management — all communicating with the aboocode server process running in the background.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  VS Code Extension                          │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Webview   │  │ Code     │  │ Status    │ │
│  │ Chat Panel│  │ Actions  │  │ Bar       │ │
│  └─────┬────┘  └────┬─────┘  └─────┬─────┘ │
│        │             │              │        │
│        └─────────┬───┘──────────────┘        │
│                  │                           │
│          ┌───────▼────────┐                  │
│          │ AbooCode Client│ (HTTP + SSE)     │
│          └───────┬────────┘                  │
└──────────────────┼──────────────────────────-┘
                   │
          ┌────────▼────────┐
          │ aboocode server │ (background process)
          │  (Hono on Bun)  │
          └─────────────────┘
```

The extension spawns `aboocode serve --port <port>` as a background child process and communicates with it over HTTP/SSE. The web UI components from `packages/app/` can be reused inside a VS Code Webview panel.

---

## Implementation Steps

### Phase 1: Server Lifecycle & Client Layer

**Step 1.1 — Background server process management**
- File: `sdks/vscode/src/server.ts` (new)
- Spawn `aboocode serve --port <port>` as a child process (not in a terminal)
- Health-check polling on startup (`GET /app`)
- Auto-restart on crash with backoff
- Clean shutdown on extension deactivation
- Store the port in extension state for reuse

**Step 1.2 — HTTP client wrapper**
- File: `sdks/vscode/src/client.ts` (new)
- Typed client for all aboocode server routes:
  - `session.*` — CRUD, messaging, diffs
  - `file.*` — read, search, list, git status
  - `config.*` — get/set configuration
  - `provider.*` — list providers/models
  - `project.*` — get current project
- Use the OpenAPI spec from `specs/` or manually type the key endpoints
- SSE event stream connection for real-time updates (`GET /event`)

### Phase 2: Chat Sidebar (Webview Panel)

**Step 2.1 — Webview panel scaffolding**
- File: `sdks/vscode/src/panels/chat-panel.ts` (new)
- Register a VS Code Webview panel in the Activity Bar (sidebar)
- Use `vscode.window.registerWebviewViewProvider` for a sidebar view
- Set up message passing between extension host and webview
- Add a new `viewsContainers` and `views` entry in `package.json`

**Step 2.2 — Chat UI inside webview**
- File: `sdks/vscode/src/panels/chat-webview/` (new directory)
- Build a lightweight chat UI (HTML/CSS/JS) that renders inside the webview
- Features:
  - Message list showing user/assistant messages with markdown rendering
  - Input box with submit button
  - Streaming response display (connect to SSE from the server)
  - Session selector dropdown (list/create/switch sessions)
  - File attachment support (send `@file#Lx-y` references)
  - Tool call result display (file edits, shell output, etc.)
- Communication: webview posts messages to extension host, which calls the aboocode client

**Step 2.3 — Context-aware prompting**
- Auto-include active file context when sending messages
- Right-click "Ask Aboocode about this" on selected code
- Drag-and-drop files into the chat panel

### Phase 3: Inline Code Actions & Editor Integration

**Step 3.1 — Code Actions provider**
- File: `sdks/vscode/src/providers/code-actions.ts` (new)
- Register a `CodeActionProvider` for all languages
- Actions:
  - "Explain this code" — sends selection to aboocode
  - "Fix this code" — sends selection with fix prompt
  - "Refactor this code" — sends selection with refactor prompt
  - "Add tests for this code" — sends selection with test prompt
- Each action opens the chat panel and sends the appropriate prompt

**Step 3.2 — Inline diff decoration**
- File: `sdks/vscode/src/providers/diff-decorator.ts` (new)
- When aboocode proposes file edits, show inline diff decorations in the editor
- Use `vscode.TextEditorDecorationType` for added/removed lines
- Accept/reject buttons via CodeLens or editor actions
- Uses the `GET /session/:id/diff` endpoint to get proposed changes

**Step 3.3 — Code completions (optional, future)**
- File: `sdks/vscode/src/providers/completions.ts` (new)
- Register an `InlineCompletionItemProvider`
- Send partial code context to aboocode for completion suggestions
- This is a stretch goal — only if the server API supports it

### Phase 4: Status Bar, Commands & Keybindings

**Step 4.1 — Status bar integration**
- File: `sdks/vscode/src/status-bar.ts` (new)
- Show aboocode status in the VS Code status bar:
  - Server status (running/stopped/error)
  - Active session name
  - Current model/provider
- Click to open quick pick with common actions

**Step 4.2 — Command palette commands**
- Update `package.json` contributes.commands with:
  - `aboocode.startServer` — Start the background server
  - `aboocode.stopServer` — Stop the background server
  - `aboocode.newSession` — Create a new chat session
  - `aboocode.switchSession` — Quick pick to switch sessions
  - `aboocode.selectModel` — Quick pick to switch AI model/provider
  - `aboocode.explainSelection` — Explain selected code
  - `aboocode.fixSelection` — Fix selected code
  - `aboocode.refactorSelection` — Refactor selected code
  - `aboocode.openSettings` — Open aboocode configuration
- Keep existing terminal commands for backward compatibility

**Step 4.3 — Keybindings**
- Keep existing keybindings
- Add: `Cmd+Shift+A` / `Ctrl+Shift+A` — Toggle chat panel
- Add: `Cmd+Shift+E` / `Ctrl+Shift+E` — Explain selection
- These are configurable via VS Code's keybinding system

### Phase 5: File Explorer & Git Integration

**Step 5.1 — Tree view for sessions**
- File: `sdks/vscode/src/views/session-tree.ts` (new)
- Register a tree view showing past sessions in the sidebar
- Each session node expands to show messages
- Click to restore/continue a session
- Uses `GET /session/` and `GET /session/:id/message`

**Step 5.2 — Git diff integration**
- File: `sdks/vscode/src/views/changes-tree.ts` (new)
- Show files changed by aboocode in a tree view (like Source Control)
- Uses `GET /session/:id/diff` to list modified files
- Click to open diff view
- "Revert" action per file using `POST /session/:id/revert`

### Phase 6: Configuration & Settings

**Step 6.1 — VS Code settings contribution**
- Add `contributes.configuration` to `package.json`:
  - `aboocode.serverPath` — Path to aboocode binary
  - `aboocode.defaultModel` — Default AI model
  - `aboocode.defaultProvider` — Default provider
  - `aboocode.autoStart` — Start server on extension activation
  - `aboocode.port` — Preferred port (or auto)
- Read these in the server lifecycle manager

**Step 6.2 — Permission handling**
- File: `sdks/vscode/src/permissions.ts` (new)
- When the server requests permission (via SSE events or polling `/permission`), show a VS Code notification with approve/deny buttons
- This replaces the TUI permission flow for the extension context

### Phase 7: Testing & Packaging

**Step 7.1 — Unit tests**
- Test the client layer with mocked HTTP responses
- Test webview message passing
- Test server lifecycle (spawn, health check, restart)

**Step 7.2 — Integration tests**
- Use `@vscode/test-electron` to run extension tests
- Test commands, webview rendering, code actions

**Step 7.3 — Build VSIX package**
- File: `sdks/vscode/scripts/build-vsix.sh` (new)
- Prerequisites:
  - Install `@vscode/vsce` globally or as a dev dependency (`npm install -D @vscode/vsce`)
  - Ensure `package.json` has required fields: `name`, `publisher`, `version`, `engines.vscode`, `main`
- Build steps:
  1. Run `bun install` to install dependencies
  2. Run `node esbuild.js --production` to bundle the extension into `dist/extension.js`
  3. Add `.vscodeignore` to exclude dev/source files from the package:
     ```
     .vscode/
     src/
     node_modules/
     .gitignore
     tsconfig.json
     esbuild.js
     **/*.ts
     !dist/**
     ```
  4. Run `vsce package --no-dependencies` to produce `aboocode-<version>.vsix`
- The `.vsix` file can then be:
  - Installed locally: `code --install-extension aboocode-<version>.vsix`
  - Shared with others for manual installation
  - Uploaded to the VS Code Marketplace via `vsce publish`
- Add an npm script in `package.json`: `"package": "node esbuild.js --production && vsce package --no-dependencies"`

**Step 7.4 — Marketplace distribution**
- Update `package.json` with proper metadata, categories (`["AI", "Chat", "Machine Learning"]`)
- Add extension icon (`images/icon.png`, 128x128 minimum)
- Add `CHANGELOG.md` for version history
- Publish with `vsce publish` (requires a Personal Access Token from Azure DevOps)

---

## File Summary

New files to create:
```
sdks/vscode/src/
├── server.ts              # Background server process management
├── client.ts              # Typed HTTP client for aboocode API
├── status-bar.ts          # Status bar integration
├── permissions.ts         # Permission request handling
├── panels/
│   ├── chat-panel.ts      # Webview panel provider
│   └── chat-webview/      # Webview HTML/CSS/JS
│       ├── index.html
│       ├── main.ts
│       └── styles.css
├── providers/
│   ├── code-actions.ts    # Code action provider
│   └── diff-decorator.ts  # Inline diff decorations
└── views/
    ├── session-tree.ts    # Session history tree view
    └── changes-tree.ts    # Changed files tree view
```

Files to modify:
```
sdks/vscode/src/extension.ts   # Wire up all new components
sdks/vscode/package.json        # Commands, views, config, keybindings
sdks/vscode/esbuild.js          # Bundle webview assets
sdks/vscode/.vscodeignore        # Exclude dev files from VSIX
sdks/vscode/scripts/build-vsix.sh # Build script for VSIX packaging
```

---

## Phasing Recommendation

- **Phase 1-2** are the MVP — a working chat sidebar backed by the real aboocode server. This alone is a significant upgrade over the terminal-only approach.
- **Phase 3-4** add polish and editor integration that make the extension feel native.
- **Phase 5-6** add power-user features and configuration.
- **Phase 7** is required for distribution.

Start with Phase 1 and 2 to get a working prototype, then iterate.
