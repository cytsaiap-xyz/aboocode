import * as vscode from "vscode"
import { AbooCodeClient, FileDiff } from "../client"

export class ChangesTreeProvider implements vscode.TreeDataProvider<ChangeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ChangeItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event
  private diffs: FileDiff[] = []
  private sessionID?: string

  constructor(private client: AbooCodeClient) {}

  async showChanges(sessionID: string, messageID?: string) {
    this.sessionID = sessionID
    try {
      this.diffs = await this.client.getDiff(sessionID, messageID)
    } catch {
      this.diffs = []
    }
    this._onDidChangeTreeData.fire(undefined)
  }

  clear() {
    this.diffs = []
    this.sessionID = undefined
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(element: ChangeItem): vscode.TreeItem {
    return element
  }

  async getChildren(): Promise<ChangeItem[]> {
    return this.diffs.map(
      (d) => new ChangeItem(d.file, d.status, this.sessionID),
    )
  }

  dispose() {
    this._onDidChangeTreeData.dispose()
  }
}

class ChangeItem extends vscode.TreeItem {
  constructor(
    public readonly filePath: string,
    public readonly status: string,
    private sessionID?: string,
  ) {
    super(filePath.split("/").pop() || filePath, vscode.TreeItemCollapsibleState.None)
    this.tooltip = filePath
    this.description = filePath
    this.contextValue = "changedFile"

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    if (workspaceFolder) {
      this.resourceUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath)
      this.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [this.resourceUri],
      }
    }

    switch (status) {
      case "added":
        this.iconPath = new vscode.ThemeIcon("diff-added")
        break
      case "modified":
        this.iconPath = new vscode.ThemeIcon("diff-modified")
        break
      case "deleted":
        this.iconPath = new vscode.ThemeIcon("diff-removed")
        break
      default:
        this.iconPath = new vscode.ThemeIcon("file")
    }
  }
}
