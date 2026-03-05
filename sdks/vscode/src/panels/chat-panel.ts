import * as vscode from "vscode"
import { AbooCodeClient, MessageWithParts, SessionInfo } from "../client"
import { AbooCodeServer } from "../server"

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "aboocode.chatView"
  private webviewView?: vscode.WebviewView
  private currentSessionID?: string
  private eventSubscription?: AbortController

  constructor(
    private context: vscode.ExtensionContext,
    private server: AbooCodeServer,
    private client: AbooCodeClient,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this.webviewView = webviewView

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    }

    webviewView.webview.html = this.getHtml(webviewView.webview)

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "sendMessage":
          await this.handleSendMessage(msg.text)
          break
        case "newSession":
          await this.handleNewSession()
          break
        case "switchSession":
          await this.handleSwitchSession(msg.sessionID)
          break
        case "loadSessions":
          await this.handleLoadSessions()
          break
        case "abort":
          if (this.currentSessionID) {
            await this.client.abortSession(this.currentSessionID)
          }
          break
        case "ready":
          await this.initialize()
          break
      }
    })
  }

  private async initialize() {
    if (this.server.status !== "running") {
      this.postMessage({ type: "status", status: "waiting" })
      return
    }

    await this.handleLoadSessions()

    // Subscribe to server events
    this.eventSubscription?.abort()
    this.eventSubscription = this.client.subscribeEvents((event) => {
      this.postMessage({ type: "serverEvent", event })
    })
  }

  async onServerReady() {
    await this.initialize()
    this.postMessage({ type: "status", status: "connected" })
  }

  onServerStopped() {
    this.eventSubscription?.abort()
    this.postMessage({ type: "status", status: "disconnected" })
  }

  private async handleLoadSessions() {
    try {
      const sessions = await this.client.listSessions({ limit: "50" })
      this.postMessage({ type: "sessions", sessions })
    } catch (e) {
      console.error("[aboocode] Failed to load sessions:", e)
    }
  }

  private async handleNewSession() {
    try {
      const session = await this.client.createSession()
      this.currentSessionID = session.id
      this.postMessage({ type: "sessionCreated", session })
      this.postMessage({ type: "messages", messages: [] })
    } catch (e) {
      console.error("[aboocode] Failed to create session:", e)
    }
  }

  private async handleSwitchSession(sessionID: string) {
    this.currentSessionID = sessionID
    try {
      const messages = await this.client.getMessages(sessionID)
      this.postMessage({ type: "messages", messages })
    } catch (e) {
      console.error("[aboocode] Failed to load messages:", e)
    }
  }

  private async handleSendMessage(text: string) {
    if (!text.trim()) return

    if (!this.currentSessionID) {
      await this.handleNewSession()
    }

    if (!this.currentSessionID) return

    this.postMessage({
      type: "userMessage",
      text,
    })

    try {
      const resp = await this.client.sendMessage(this.currentSessionID, {
        parts: [{ type: "text", text }],
      })

      if (!resp.body) return

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          if (line.trim()) {
            try {
              const chunk = JSON.parse(line)
              this.postMessage({ type: "streamChunk", chunk })
            } catch {}
          }
        }
      }

      this.postMessage({ type: "streamEnd" })
    } catch (e: any) {
      this.postMessage({
        type: "error",
        message: e.message || "Failed to send message",
      })
    }
  }

  appendToPrompt(text: string) {
    this.postMessage({ type: "appendPrompt", text })
  }

  private postMessage(msg: unknown) {
    this.webviewView?.webview.postMessage(msg)
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce()
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "chat.css"),
    )

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link href="${styleUri}" rel="stylesheet">
  <title>Aboocode</title>
</head>
<body>
  <div id="app">
    <div id="toolbar">
      <select id="session-select">
        <option value="">New Session</option>
      </select>
      <button id="new-session-btn" title="New Session">+</button>
    </div>
    <div id="status-bar-top">
      <span id="status-text">Connecting...</span>
    </div>
    <div id="messages"></div>
    <div id="input-area">
      <textarea id="prompt-input" placeholder="Ask aboocode..." rows="3"></textarea>
      <div id="input-actions">
        <button id="send-btn" title="Send">Send</button>
        <button id="abort-btn" title="Stop" class="hidden">Stop</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const promptInput = document.getElementById('prompt-input');
    const sendBtn = document.getElementById('send-btn');
    const abortBtn = document.getElementById('abort-btn');
    const sessionSelect = document.getElementById('session-select');
    const newSessionBtn = document.getElementById('new-session-btn');
    const statusText = document.getElementById('status-text');

    let isStreaming = false;
    let currentAssistantEl = null;

    function escapeHtml(text) {
      const el = document.createElement('div');
      el.textContent = text;
      return el.innerHTML;
    }

    function addMessage(role, content) {
      const div = document.createElement('div');
      div.className = 'message ' + role;
      div.innerHTML = '<div class="message-role">' + role + '</div><div class="message-content">' + escapeHtml(content) + '</div>';
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function startAssistantMessage() {
      const div = document.createElement('div');
      div.className = 'message assistant';
      div.innerHTML = '<div class="message-role">assistant</div><div class="message-content"></div>';
      messagesEl.appendChild(div);
      currentAssistantEl = div.querySelector('.message-content');
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function setStreaming(val) {
      isStreaming = val;
      sendBtn.classList.toggle('hidden', val);
      abortBtn.classList.toggle('hidden', !val);
      promptInput.disabled = val;
    }

    function renderMessages(messages) {
      messagesEl.innerHTML = '';
      for (const msg of messages) {
        const role = msg.info.role;
        const textParts = msg.parts
          .filter(p => p.type === 'text')
          .map(p => p.content || p.text || '')
          .join('\\n');
        if (textParts) {
          addMessage(role, textParts);
        }
        // Show tool use summaries
        const toolParts = msg.parts.filter(p => p.type === 'tool-invocation' || p.type === 'tool-result');
        for (const tp of toolParts) {
          const toolDiv = document.createElement('div');
          toolDiv.className = 'message tool';
          const toolName = tp.toolName || tp.name || 'tool';
          toolDiv.innerHTML = '<div class="tool-badge">' + escapeHtml(toolName) + '</div>';
          messagesEl.appendChild(toolDiv);
        }
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    sendBtn.addEventListener('click', sendMessage);
    abortBtn.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));
    newSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));

    sessionSelect.addEventListener('change', () => {
      const id = sessionSelect.value;
      if (id) {
        vscode.postMessage({ type: 'switchSession', sessionID: id });
      } else {
        vscode.postMessage({ type: 'newSession' });
      }
    });

    function sendMessage() {
      const text = promptInput.value.trim();
      if (!text || isStreaming) return;
      promptInput.value = '';
      vscode.postMessage({ type: 'sendMessage', text });
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'status':
          if (msg.status === 'connected') {
            statusText.textContent = 'Connected';
            statusText.className = 'connected';
          } else if (msg.status === 'disconnected') {
            statusText.textContent = 'Disconnected';
            statusText.className = 'disconnected';
          } else {
            statusText.textContent = 'Waiting for server...';
            statusText.className = '';
          }
          break;

        case 'sessions': {
          const current = sessionSelect.value;
          sessionSelect.innerHTML = '<option value="">New Session</option>';
          for (const s of msg.sessions) {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.title || ('Session ' + s.id.slice(0, 8));
            sessionSelect.appendChild(opt);
          }
          if (current) sessionSelect.value = current;
          break;
        }

        case 'sessionCreated':
          sessionSelect.value = msg.session.id;
          break;

        case 'messages':
          renderMessages(msg.messages);
          break;

        case 'userMessage':
          addMessage('user', msg.text);
          setStreaming(true);
          startAssistantMessage();
          break;

        case 'streamChunk':
          if (currentAssistantEl && msg.chunk) {
            // Handle different chunk formats
            if (msg.chunk.parts) {
              for (const part of msg.chunk.parts) {
                if (part.type === 'text' && (part.content || part.text)) {
                  currentAssistantEl.textContent += (part.content || part.text);
                }
              }
            }
          }
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;

        case 'streamEnd':
          setStreaming(false);
          currentAssistantEl = null;
          break;

        case 'error':
          setStreaming(false);
          currentAssistantEl = null;
          addMessage('error', msg.message);
          break;

        case 'appendPrompt':
          promptInput.value += msg.text;
          promptInput.focus();
          break;
      }
    });

    // Signal ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`
  }

  dispose() {
    this.eventSubscription?.abort()
  }
}

function getNonce(): string {
  let text = ""
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return text
}
