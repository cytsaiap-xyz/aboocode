import { spawn } from "child_process"
import os from "os"
import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./push-notification.txt"

function runCommand(cmd: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] })
    const chunks: Buffer[] = []
    child.stderr?.on("data", (c) => chunks.push(c))
    child.on("error", () => resolve({ code: -1, stderr: "spawn failed" }))
    child.on("close", (code) => resolve({ code, stderr: Buffer.concat(chunks).toString("utf-8") }))
  })
}

function escapeAppleScript(s: string): string {
  // Escape backslash then double-quote for AppleScript string literal.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export const PushNotificationTool = Tool.define("push_notification", {
  description: DESCRIPTION,
  parameters: z.object({
    title: z.string().max(120).describe("Short title (<60 chars recommended)"),
    body: z.string().max(600).describe("Body text (<300 chars recommended)"),
    sound: z.boolean().default(false).describe("Play a notification sound if supported"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "notification",
      patterns: [params.title],
      always: ["*"],
      metadata: { title: params.title },
    })

    const platform = os.platform()
    let delivered = false
    let detail = ""

    if (platform === "darwin") {
      const script = `display notification "${escapeAppleScript(params.body)}" with title "${escapeAppleScript(params.title)}"${params.sound ? ' sound name "default"' : ""}`
      const res = await runCommand("osascript", ["-e", script])
      delivered = res.code === 0
      detail = res.stderr || `osascript exit ${res.code}`
    } else if (platform === "linux") {
      const args = [params.title, params.body]
      if (params.sound) args.push("-u", "normal")
      const res = await runCommand("notify-send", args)
      delivered = res.code === 0
      detail = res.stderr || `notify-send exit ${res.code}`
    } else if (platform === "win32") {
      // Simple toast via powershell. Fancy toast APIs require more setup.
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, "${params.title.replace(/"/g, "'")}", "${params.body.replace(/"/g, "'")}", 'Info'); Start-Sleep -s 2`
      const res = await runCommand("powershell", ["-NoProfile", "-Command", ps])
      delivered = res.code === 0
      detail = res.stderr || `powershell exit ${res.code}`
    } else {
      detail = `Unsupported platform: ${platform}`
    }

    return {
      title: delivered ? `Notified: ${params.title}` : `Notification failed on ${platform}`,
      output: delivered ? `Delivered notification "${params.title}" on ${platform}.` : `Could not deliver notification on ${platform}: ${detail}`,
      metadata: { delivered, platform, detail },
    }
  },
})
