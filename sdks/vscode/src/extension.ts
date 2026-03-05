import * as vscode from "vscode"
import { AbooCodeServer } from "./server"
import { AbooCodeClient } from "./client"
import { ChatPanelProvider } from "./panels/chat-panel"
import { AbooCodeActionProvider, getSelectionContext } from "./providers/code-actions"
import { DiffDecorator } from "./providers/diff-decorator"
import { StatusBar } from "./status-bar"
import { PermissionHandler } from "./permissions"
import { SessionTreeProvider } from "./views/session-tree"
import { ChangesTreeProvider } from "./views/changes-tree"

const TERMINAL_NAME = "aboocode"

export function activate(context: vscode.ExtensionContext) {
  // Core: server + client
  const server = new AbooCodeServer(context)
  const client = new AbooCodeClient(server)

  // UI components
  const chatPanel = new ChatPanelProvider(context, server, client)
  const statusBar = new StatusBar(server)
  const permissions = new PermissionHandler(client)
  const diffDecorator = new DiffDecorator(client)
  const sessionTree = new SessionTreeProvider(client)
  const changesTree = new ChangesTreeProvider(client)

  // Register webview sidebar
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewType, chatPanel),
  )

  // Register tree views
  context.subscriptions.push(
    vscode.window.createTreeView("aboocode.sessionsView", {
      treeDataProvider: sessionTree,
      showCollapseAll: false,
    }),
    vscode.window.createTreeView("aboocode.changesView", {
      treeDataProvider: changesTree,
      showCollapseAll: false,
    }),
  )

  // Register code actions
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new AbooCodeActionProvider(),
      { providedCodeActionKinds: AbooCodeActionProvider.providedCodeActionKinds },
    ),
  )

  // Server lifecycle: auto-start if configured
  server.onStatusChange((status) => {
    if (status === "running") {
      chatPanel.onServerReady()
      permissions.startPolling()
      sessionTree.refresh()
    } else if (status === "stopped" || status === "error") {
      chatPanel.onServerStopped()
      permissions.stopPolling()
    }
  })

  const autoStart = vscode.workspace.getConfiguration("aboocode").get<boolean>("autoStart", true)
  if (autoStart) {
    server.start()
  }

  // ── Commands ──────────────────────────────────────────────

  // Server commands
  context.subscriptions.push(
    vscode.commands.registerCommand("aboocode.startServer", () => server.start()),
    vscode.commands.registerCommand("aboocode.stopServer", () => server.stop()),
    vscode.commands.registerCommand("aboocode.restartServer", () => server.restart()),
  )

  // Session commands
  context.subscriptions.push(
    vscode.commands.registerCommand("aboocode.newSession", () => {
      chatPanel.appendToPrompt("")
      vscode.commands.executeCommand("aboocode.chatView.focus")
    }),
    vscode.commands.registerCommand("aboocode.switchSession", async (sessionID?: string) => {
      if (!sessionID) {
        const sessions = await client.listSessions({ limit: "20" })
        const pick = await vscode.window.showQuickPick(
          sessions.map((s) => ({
            label: s.title || `Session ${s.id.slice(0, 8)}`,
            description: new Date(s.time.created).toLocaleString(),
            sessionID: s.id,
          })),
          { placeHolder: "Select a session" },
        )
        if (!pick) return
        sessionID = pick.sessionID
      }
      vscode.commands.executeCommand("aboocode.chatView.focus")
      // The chat panel listens for switchSession via webview messaging
      chatPanel["handleSwitchSession"](sessionID)
    }),
  )

  // Model/provider selection
  context.subscriptions.push(
    vscode.commands.registerCommand("aboocode.selectModel", async () => {
      try {
        const providers = await client.getProviders()
        const items: vscode.QuickPickItem[] = []
        for (const p of providers.all) {
          for (const m of p.models || []) {
            items.push({
              label: m.name || m.id,
              description: p.name || p.id,
            })
          }
        }
        await vscode.window.showQuickPick(items, { placeHolder: "Select a model" })
      } catch {
        vscode.window.showErrorMessage("Failed to load models. Is the server running?")
      }
    }),
  )

  // Code action commands
  function sendSelectionPrompt(prefix: string) {
    const ctx = getSelectionContext()
    if (!ctx) {
      vscode.window.showWarningMessage("Select some code first.")
      return
    }
    vscode.commands.executeCommand("aboocode.chatView.focus")
    chatPanel.appendToPrompt(`${prefix} ${ctx.fileRef}\n\n\`\`\`\n${ctx.text}\n\`\`\``)
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("aboocode.explainSelection", () =>
      sendSelectionPrompt("Explain this code:")),
    vscode.commands.registerCommand("aboocode.fixSelection", () =>
      sendSelectionPrompt("Fix this code:")),
    vscode.commands.registerCommand("aboocode.refactorSelection", () =>
      sendSelectionPrompt("Refactor this code:")),
    vscode.commands.registerCommand("aboocode.addTestsForSelection", () =>
      sendSelectionPrompt("Add tests for this code:")),
  )

  // Quick pick (status bar click)
  context.subscriptions.push(
    vscode.commands.registerCommand("aboocode.showQuickPick", async () => {
      const items: vscode.QuickPickItem[] = [
        { label: "$(comment-discussion) Open Chat", description: "Open the Aboocode chat panel" },
        { label: "$(add) New Session", description: "Start a new chat session" },
        { label: "$(server) Restart Server", description: "Restart the Aboocode server" },
        { label: "$(terminal) Open in Terminal", description: "Open Aboocode in a terminal" },
        { label: "$(symbol-misc) Select Model", description: "Choose AI model" },
        { label: "$(gear) Settings", description: "Open Aboocode settings" },
      ]
      const pick = await vscode.window.showQuickPick(items, { placeHolder: "Aboocode" })
      if (!pick) return
      if (pick.label.includes("Open Chat")) {
        vscode.commands.executeCommand("aboocode.chatView.focus")
      } else if (pick.label.includes("New Session")) {
        vscode.commands.executeCommand("aboocode.newSession")
      } else if (pick.label.includes("Restart Server")) {
        server.restart()
      } else if (pick.label.includes("Open in Terminal")) {
        vscode.commands.executeCommand("aboocode.openTerminal")
      } else if (pick.label.includes("Select Model")) {
        vscode.commands.executeCommand("aboocode.selectModel")
      } else if (pick.label.includes("Settings")) {
        vscode.commands.executeCommand("workbench.action.openSettings", "aboocode")
      }
    }),
  )

  // Context menu: add file reference
  context.subscriptions.push(
    vscode.commands.registerCommand("aboocode.addFilepathToChat", () => {
      const fileRef = getActiveFile()
      if (fileRef) {
        vscode.commands.executeCommand("aboocode.chatView.focus")
        chatPanel.appendToPrompt(fileRef)
      }
    }),
  )

  // Settings command
  context.subscriptions.push(
    vscode.commands.registerCommand("aboocode.openSettings", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "aboocode")
    }),
  )

  // ── Legacy terminal commands (backward compat) ────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("aboocode.openNewTerminal", async () => {
      await openTerminal(context)
    }),
    vscode.commands.registerCommand("aboocode.openTerminal", async () => {
      const existingTerminal = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
      if (existingTerminal) {
        existingTerminal.show()
        return
      }
      await openTerminal(context)
    }),
    vscode.commands.registerCommand("aboocode.addFilepathToTerminal", async () => {
      const fileRef = getActiveFile()
      if (!fileRef) return
      const terminal = vscode.window.activeTerminal
      if (!terminal) return
      if (terminal.name === TERMINAL_NAME) {
        // @ts-ignore
        const port = terminal.creationOptions.env?.["_EXTENSION_OPENCODE_PORT"]
        if (port) {
          await fetch(`http://localhost:${port}/tui/append-prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: fileRef }),
          })
        } else {
          terminal.sendText(fileRef, false)
        }
        terminal.show()
      }
    }),
  )

  // Disposables
  context.subscriptions.push(
    server,
    statusBar,
    permissions,
    diffDecorator,
    chatPanel,
    sessionTree,
    changesTree,
  )
}

export function deactivate() {}

// ── Helpers ────────────────────────────────────────────────

async function openTerminal(context: vscode.ExtensionContext) {
  const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    iconPath: {
      light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
      dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
    },
    location: {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
    },
    env: {
      _EXTENSION_OPENCODE_PORT: port.toString(),
      OPENCODE_CALLER: "vscode",
    },
  })

  terminal.show()
  terminal.sendText(`aboocode --port ${port}`)

  const fileRef = getActiveFile()
  if (!fileRef) return

  let tries = 10
  let connected = false
  do {
    await new Promise((resolve) => setTimeout(resolve, 200))
    try {
      await fetch(`http://localhost:${port}/app`)
      connected = true
      break
    } catch {}
    tries--
  } while (tries > 0)

  if (connected) {
    await fetch(`http://localhost:${port}/tui/append-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `In ${fileRef}` }),
    })
    terminal.show()
  }
}

function getActiveFile(): string | undefined {
  const activeEditor = vscode.window.activeTextEditor
  if (!activeEditor) return
  const document = activeEditor.document
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
  if (!workspaceFolder) return

  const relativePath = vscode.workspace.asRelativePath(document.uri)
  let filepathWithAt = `@${relativePath}`

  const selection = activeEditor.selection
  if (!selection.isEmpty) {
    const startLine = selection.start.line + 1
    const endLine = selection.end.line + 1
    filepathWithAt += startLine === endLine ? `#L${startLine}` : `#L${startLine}-${endLine}`
  }

  return filepathWithAt
}
