import * as vscode from "vscode"
import { ChildProcess, spawn } from "child_process"

export class AbooCodeServer {
  private process: ChildProcess | null = null
  private port: number = 0
  private restartCount = 0
  private maxRestarts = 5
  private disposed = false
  private _onStatusChange = new vscode.EventEmitter<ServerStatus>()
  readonly onStatusChange = this._onStatusChange.event
  private _status: ServerStatus = "stopped"

  constructor(private context: vscode.ExtensionContext) {}

  get baseUrl(): string {
    return `http://localhost:${this.port}`
  }

  get status(): ServerStatus {
    return this._status
  }

  private setStatus(status: ServerStatus) {
    this._status = status
    this._onStatusChange.fire(status)
  }

  async start(): Promise<void> {
    if (this.process) {
      return
    }

    this.disposed = false
    this.port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
    const serverPath =
      vscode.workspace.getConfiguration("aboocode").get<string>("serverPath") || "aboocode"

    this.setStatus("starting")

    this.process = spawn(serverPath, ["serve", "--port", String(this.port)], {
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      stdio: "pipe",
      env: {
        ...process.env,
        ABOOCODE_CALLER: "vscode",
      },
    })

    this.process.on("error", (err) => {
      console.error("[aboocode] Server process error:", err.message)
      this.setStatus("error")
      this.handleCrash()
    })

    this.process.on("exit", (code) => {
      this.process = null
      if (!this.disposed) {
        console.error(`[aboocode] Server exited with code ${code}`)
        this.setStatus("error")
        this.handleCrash()
      } else {
        this.setStatus("stopped")
      }
    })

    this.process.stderr?.on("data", (data) => {
      console.error("[aboocode]", data.toString())
    })

    const ready = await this.waitForReady()
    if (ready) {
      this.restartCount = 0
      this.setStatus("running")
    } else {
      this.setStatus("error")
    }
  }

  private async waitForReady(): Promise<boolean> {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500))
      try {
        const resp = await fetch(`${this.baseUrl}/app`)
        if (resp.ok) return true
      } catch {}
    }
    return false
  }

  private async handleCrash() {
    if (this.disposed || this.restartCount >= this.maxRestarts) {
      if (this.restartCount >= this.maxRestarts) {
        vscode.window.showErrorMessage(
          "Aboocode server crashed too many times. Use 'Aboocode: Start Server' to restart.",
        )
      }
      return
    }
    this.restartCount++
    const delay = Math.pow(2, this.restartCount) * 1000
    await new Promise((r) => setTimeout(r, delay))
    if (!this.disposed) {
      await this.start()
    }
  }

  async stop(): Promise<void> {
    this.disposed = true
    if (this.process) {
      this.process.kill()
      this.process = null
    }
    this.setStatus("stopped")
  }

  async restart(): Promise<void> {
    await this.stop()
    this.restartCount = 0
    await this.start()
  }

  dispose() {
    this.disposed = true
    this._onStatusChange.dispose()
    if (this.process) {
      this.process.kill()
      this.process = null
    }
  }
}

export type ServerStatus = "stopped" | "starting" | "running" | "error"
