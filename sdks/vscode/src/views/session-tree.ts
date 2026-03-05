import * as vscode from "vscode"
import { AbooCodeClient, SessionInfo } from "../client"

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event
  private sessions: SessionInfo[] = []

  constructor(private client: AbooCodeClient) {}

  refresh() {
    this.loadSessions()
  }

  private async loadSessions() {
    try {
      this.sessions = await this.client.listSessions({ limit: "50" })
    } catch {
      this.sessions = []
    }
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element
  }

  async getChildren(element?: SessionItem): Promise<SessionItem[]> {
    if (element) return []

    if (this.sessions.length === 0) {
      await this.loadSessions()
    }

    return this.sessions.map(
      (s) =>
        new SessionItem(
          s.title || `Session ${s.id.slice(0, 8)}`,
          s.id,
          s.time.created,
        ),
    )
  }

  dispose() {
    this._onDidChangeTreeData.dispose()
  }
}

class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly sessionID: string,
    public readonly created: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.tooltip = `Created: ${new Date(created).toLocaleString()}`
    this.description = new Date(created).toLocaleDateString()
    this.contextValue = "session"
    this.command = {
      command: "aboocode.switchSession",
      title: "Switch to Session",
      arguments: [sessionID],
    }
    this.iconPath = new vscode.ThemeIcon("comment-discussion")
  }
}
