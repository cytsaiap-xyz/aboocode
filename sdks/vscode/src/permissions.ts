import * as vscode from "vscode"
import { AbooCodeClient } from "./client"

export class PermissionHandler {
  private pollInterval?: ReturnType<typeof setInterval>

  constructor(private client: AbooCodeClient) {}

  startPolling() {
    this.stopPolling()
    this.pollInterval = setInterval(() => this.checkPermissions(), 1000)
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = undefined
    }
  }

  private async checkPermissions() {
    try {
      const requests = await this.client.getPermissions()
      for (const req of requests) {
        await this.showPermissionPrompt(req)
      }
    } catch {
      // Server may not be ready
    }
  }

  private async showPermissionPrompt(req: {
    id: string
    type: string
    message: string
  }) {
    const action = await vscode.window.showWarningMessage(
      `Aboocode requests permission: ${req.message}`,
      { modal: false },
      "Allow",
      "Allow Always",
      "Deny",
    )

    let reply: string
    switch (action) {
      case "Allow":
        reply = "allow"
        break
      case "Allow Always":
        reply = "always"
        break
      case "Deny":
        reply = "deny"
        break
      default:
        reply = "deny"
        break
    }

    try {
      await this.client.replyPermission(req.id, reply)
    } catch (e) {
      console.error("[aboocode] Failed to reply permission:", e)
    }
  }

  dispose() {
    this.stopPolling()
  }
}
