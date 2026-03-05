import { AbooCodeServer } from "./server"

export interface SessionInfo {
  id: string
  title?: string
  parentID?: string
  version: number
  time: {
    created: string
    updated: string
    archived?: string
  }
}

export interface MessagePart {
  id: string
  type: string
  [key: string]: unknown
}

export interface MessageInfo {
  id: string
  role: "user" | "assistant"
  sessionID: string
  time: { created: string }
}

export interface MessageWithParts {
  info: MessageInfo
  parts: MessagePart[]
}

export interface FileDiff {
  file: string
  status: string
  hunks: unknown[]
}

export interface FileNode {
  name: string
  type: "file" | "directory"
  path: string
}

export interface FileContent {
  path: string
  content: string
}

export interface FileInfo {
  path: string
  status: string
}

export interface ConfigInfo {
  [key: string]: unknown
}

export interface ProviderInfo {
  id: string
  name: string
  models: { id: string; name: string }[]
}

export interface PermissionRequest {
  id: string
  type: string
  message: string
  [key: string]: unknown
}

export class AbooCodeClient {
  constructor(private server: AbooCodeServer) {}

  private get base(): string {
    return this.server.baseUrl
  }

  private async get<T>(path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.base)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, v)
      }
    }
    const resp = await fetch(url.toString())
    if (!resp.ok) throw new Error(`GET ${path} failed: ${resp.status}`)
    return resp.json() as Promise<T>
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const resp = await fetch(new URL(path, this.base).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!resp.ok) throw new Error(`POST ${path} failed: ${resp.status}`)
    return resp.json() as Promise<T>
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    const resp = await fetch(new URL(path, this.base).toString(), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!resp.ok) throw new Error(`PATCH ${path} failed: ${resp.status}`)
    return resp.json() as Promise<T>
  }

  private async del<T>(path: string): Promise<T> {
    const resp = await fetch(new URL(path, this.base).toString(), {
      method: "DELETE",
    })
    if (!resp.ok) throw new Error(`DELETE ${path} failed: ${resp.status}`)
    return resp.json() as Promise<T>
  }

  // Session APIs
  async listSessions(opts?: {
    search?: string
    limit?: string
  }): Promise<SessionInfo[]> {
    return this.get("/session/", opts)
  }

  async createSession(): Promise<SessionInfo> {
    return this.post("/session/")
  }

  async getSession(sessionID: string): Promise<SessionInfo> {
    return this.get(`/session/${sessionID}`)
  }

  async deleteSession(sessionID: string): Promise<boolean> {
    return this.del(`/session/${sessionID}`)
  }

  async updateSession(
    sessionID: string,
    update: { title?: string },
  ): Promise<SessionInfo> {
    return this.patch(`/session/${sessionID}`, update)
  }

  async getMessages(
    sessionID: string,
    limit?: string,
  ): Promise<MessageWithParts[]> {
    return this.get(`/session/${sessionID}/message`, limit ? { limit } : undefined)
  }

  async sendMessage(
    sessionID: string,
    input: { parts: { type: string; text?: string; [key: string]: unknown }[] },
  ): Promise<Response> {
    // Returns raw response for streaming
    const resp = await fetch(
      new URL(`/session/${sessionID}/message`, this.base).toString(),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    )
    if (!resp.ok) throw new Error(`POST message failed: ${resp.status}`)
    return resp
  }

  async sendMessageAsync(
    sessionID: string,
    input: { parts: { type: string; text?: string; [key: string]: unknown }[] },
  ): Promise<void> {
    const resp = await fetch(
      new URL(`/session/${sessionID}/prompt_async`, this.base).toString(),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    )
    if (!resp.ok) throw new Error(`POST prompt_async failed: ${resp.status}`)
  }

  async abortSession(sessionID: string): Promise<boolean> {
    return this.post(`/session/${sessionID}/abort`)
  }

  async getDiff(
    sessionID: string,
    messageID?: string,
  ): Promise<FileDiff[]> {
    return this.get(
      `/session/${sessionID}/diff`,
      messageID ? { messageID } : undefined,
    )
  }

  async revertSession(
    sessionID: string,
    input: { messageID?: string },
  ): Promise<SessionInfo> {
    return this.post(`/session/${sessionID}/revert`, input)
  }

  async forkSession(sessionID: string): Promise<SessionInfo> {
    return this.post(`/session/${sessionID}/fork`, {})
  }

  // File APIs
  async listFiles(path: string): Promise<FileNode[]> {
    return this.get("/file", { path })
  }

  async readFile(path: string): Promise<FileContent> {
    return this.get("/file/content", { path })
  }

  async getFileStatus(): Promise<FileInfo[]> {
    return this.get("/file/status")
  }

  async searchFiles(query: string): Promise<string[]> {
    return this.get("/find/file", { query })
  }

  async searchContent(pattern: string): Promise<unknown[]> {
    return this.get("/find", { pattern })
  }

  // Config APIs
  async getConfig(): Promise<ConfigInfo> {
    return this.get("/config/")
  }

  async updateConfig(config: Partial<ConfigInfo>): Promise<ConfigInfo> {
    return this.patch("/config/", config)
  }

  // Provider APIs
  async getProviders(): Promise<{
    all: ProviderInfo[]
    default: Record<string, string>
    connected: string[]
  }> {
    return this.get("/provider/")
  }

  // Permission APIs
  async getPermissions(): Promise<PermissionRequest[]> {
    return this.get("/permission/")
  }

  async replyPermission(
    requestID: string,
    reply: string,
    message?: string,
  ): Promise<boolean> {
    return this.post(`/permission/${requestID}/reply`, { reply, message })
  }

  // Event stream (SSE)
  subscribeEvents(onEvent: (event: { type: string; data: unknown }) => void): AbortController {
    const controller = new AbortController()
    const url = new URL("/event", this.base).toString()

    const connect = () => {
      fetch(url, { signal: controller.signal })
        .then(async (resp) => {
          if (!resp.ok || !resp.body) return
          const reader = resp.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            const lines = buffer.split("\n")
            buffer = lines.pop() || ""

            let eventType = "message"
            for (const line of lines) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7).trim()
              } else if (line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6))
                  onEvent({ type: eventType, data })
                } catch {}
                eventType = "message"
              }
            }
          }
          // Reconnect if not aborted
          if (!controller.signal.aborted) {
            setTimeout(connect, 2000)
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setTimeout(connect, 2000)
          }
        })
    }

    connect()
    return controller
  }

  // TUI integration
  async appendPrompt(text: string): Promise<boolean> {
    return this.post("/tui/append-prompt", { text })
  }
}
