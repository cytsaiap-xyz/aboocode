import { spawn } from "child_process"
import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./monitor.txt"

const DEFAULT_TIMEOUT_S = 60
const MAX_TIMEOUT_S = 600
const DEFAULT_MAX_LINES = 200

export const MonitorTool = Tool.define("monitor", {
  description: DESCRIPTION,
  parameters: z.object({
    command: z.string().describe("Shell command to run (via sh -c)"),
    timeoutSeconds: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_S)
      .optional()
      .describe(`Seconds to watch before returning. Default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}`),
    maxLines: z
      .number()
      .int()
      .positive()
      .max(5000)
      .optional()
      .describe(`Return after this many lines are produced. Default ${DEFAULT_MAX_LINES}, max 5000`),
    cwd: z.string().optional().describe("Working directory (absolute path). Defaults to session cwd"),
  }),
  async execute(params, ctx) {
    const timeoutMs = (params.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000
    const maxLines = params.maxLines ?? DEFAULT_MAX_LINES

    await ctx.ask({
      permission: "bash",
      patterns: [params.command],
      always: [params.command],
      metadata: { command: params.command, kind: "monitor" },
    })

    const result = await new Promise<{
      exitCode: number | null
      stdout: string
      stderr: string
      reason: "exit" | "maxLines" | "timeout" | "aborted"
      linesCaptured: number
    }>((resolve) => {
      const child = spawn("sh", ["-c", params.command], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: params.cwd,
      })
      const stdoutLines: string[] = []
      const stderrLines: string[] = []
      let stdoutBuf = ""
      let stderrBuf = ""
      let done = false
      let reason: "exit" | "maxLines" | "timeout" | "aborted" = "exit"

      const finish = (exitCode: number | null) => {
        if (done) return
        done = true
        clearTimeout(timer)
        ctx.abort.removeEventListener("abort", onAbort)
        if (stdoutBuf) stdoutLines.push(stdoutBuf)
        if (stderrBuf) stderrLines.push(stderrBuf)
        const tail = (arr: string[]) => (arr.length > maxLines ? arr.slice(-maxLines) : arr).join("\n")
        resolve({
          exitCode,
          stdout: tail(stdoutLines),
          stderr: tail(stderrLines),
          reason,
          linesCaptured: stdoutLines.length + stderrLines.length,
        })
        if (!child.killed) child.kill("SIGTERM")
      }

      const timer = setTimeout(() => {
        reason = "timeout"
        finish(null)
      }, timeoutMs)

      const onAbort = () => {
        reason = "aborted"
        finish(null)
      }
      ctx.abort.addEventListener("abort", onAbort, { once: true })

      const consume = (chunk: Buffer, sink: string[], bufRef: { val: string }) => {
        bufRef.val += chunk.toString("utf-8")
        let idx = bufRef.val.indexOf("\n")
        while (idx !== -1) {
          sink.push(bufRef.val.slice(0, idx))
          bufRef.val = bufRef.val.slice(idx + 1)
          if (sink.length >= maxLines && reason === "exit") {
            reason = "maxLines"
            finish(null)
            return
          }
          idx = bufRef.val.indexOf("\n")
        }
      }

      const stdoutRef = { val: stdoutBuf }
      const stderrRef = { val: stderrBuf }
      child.stdout?.on("data", (c) => consume(c, stdoutLines, stdoutRef))
      child.stderr?.on("data", (c) => consume(c, stderrLines, stderrRef))
      child.on("error", (e) => {
        stderrLines.push(`[monitor] spawn error: ${e.message}`)
        finish(null)
      })
      child.on("close", (code) => {
        // `buf` is now in stdoutRef.val / stderrRef.val due to closure
        stdoutBuf = stdoutRef.val
        stderrBuf = stderrRef.val
        finish(code)
      })
    })

    return {
      title: `Monitor: ${params.command.slice(0, 40)}${params.command.length > 40 ? "…" : ""} (${result.reason})`,
      output: [
        `reason: ${result.reason}`,
        `exitCode: ${result.exitCode ?? "null"}`,
        `linesCaptured: ${result.linesCaptured}`,
        result.stdout ? `\n--- stdout (last ${Math.min(result.linesCaptured, result.stdout.split("\n").length)} lines) ---\n${result.stdout}` : "",
        result.stderr ? `\n--- stderr ---\n${result.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        exitCode: result.exitCode,
        reason: result.reason,
        linesCaptured: result.linesCaptured,
      },
    }
  },
})
