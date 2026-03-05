import * as vscode from "vscode"
import { AbooCodeServer, ServerStatus } from "./server"

export class StatusBar {
  private item: vscode.StatusBarItem

  constructor(private server: AbooCodeServer) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.item.command = "aboocode.showQuickPick"
    this.update(server.status)

    server.onStatusChange((status) => this.update(status))
  }

  private update(status: ServerStatus) {
    switch (status) {
      case "running":
        this.item.text = "$(check) Aboocode"
        this.item.tooltip = "Aboocode server is running"
        this.item.backgroundColor = undefined
        break
      case "starting":
        this.item.text = "$(loading~spin) Aboocode"
        this.item.tooltip = "Aboocode server is starting..."
        this.item.backgroundColor = undefined
        break
      case "error":
        this.item.text = "$(error) Aboocode"
        this.item.tooltip = "Aboocode server error — click to restart"
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground",
        )
        break
      case "stopped":
        this.item.text = "$(circle-outline) Aboocode"
        this.item.tooltip = "Aboocode server is stopped — click to start"
        this.item.backgroundColor = undefined
        break
    }
    this.item.show()
  }

  dispose() {
    this.item.dispose()
  }
}
