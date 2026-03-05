import * as vscode from "vscode"
import { AbooCodeClient, FileDiff } from "../client"

const addedDecorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
  isWholeLine: true,
})

const removedDecorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
  isWholeLine: true,
})

export class DiffDecorator {
  private decoratedEditors = new Map<string, vscode.TextEditor>()

  constructor(private client: AbooCodeClient) {}

  async showDiffs(sessionID: string, messageID?: string) {
    try {
      const diffs = await this.client.getDiff(sessionID, messageID)
      this.clearAll()

      for (const diff of diffs) {
        await this.decorateFile(diff)
      }
    } catch (e) {
      console.error("[aboocode] Failed to show diffs:", e)
    }
  }

  private async decorateFile(diff: FileDiff) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    if (!workspaceFolder) return

    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, diff.file)
    try {
      const document = await vscode.workspace.openTextDocument(fileUri)
      const editor = await vscode.window.showTextDocument(document, { preview: true })

      this.decoratedEditors.set(diff.file, editor)

      // For now, we show a simple notification about changes
      // A full diff view is better handled by VS Code's built-in diff editor
      vscode.window.showInformationMessage(
        `Aboocode modified: ${diff.file}`,
        "View Diff",
        "Revert",
      ).then((action) => {
        if (action === "View Diff") {
          vscode.commands.executeCommand("git.openChange", fileUri)
        }
      })
    } catch {
      // File may not exist yet
    }
  }

  clearAll() {
    for (const editor of this.decoratedEditors.values()) {
      editor.setDecorations(addedDecorationType, [])
      editor.setDecorations(removedDecorationType, [])
    }
    this.decoratedEditors.clear()
  }

  dispose() {
    this.clearAll()
    addedDecorationType.dispose()
    removedDecorationType.dispose()
  }
}
