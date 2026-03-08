import path from "path"
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { Global } from "./global"

export namespace UsageLog {
  function getLogPath(): string {
    return path.join(Global.Path.data, "usage.log")
  }

  function formatTimestamp(): string {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  }

  function formatMetadata(metadata?: Record<string, any>): string {
    if (!metadata) return ""
    const pairs = Object.entries(metadata)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        const val = typeof v === "string" ? `"${v}"` : String(v)
        return `${k}=${val}`
      })
    return pairs.length > 0 ? " | " + pairs.join(" ") : ""
  }

  export function record(module: string, fn: string, metadata?: Record<string, any>): void {
    try {
      const logPath = getLogPath()
      const dir = path.dirname(logPath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      const label = `${module}.${fn}`.padEnd(40)
      const line = `[${formatTimestamp()}] ${label}${formatMetadata(metadata)}\n`
      appendFileSync(logPath, line)
    } catch {
      // Fire-and-forget — never throw from logging
    }
  }

  export function read(): string {
    try {
      const logPath = getLogPath()
      if (!existsSync(logPath)) return ""
      return readFileSync(logPath, "utf-8")
    } catch {
      return ""
    }
  }

  export function clear(): void {
    try {
      const logPath = getLogPath()
      if (existsSync(logPath)) {
        writeFileSync(logPath, "")
      }
    } catch {
      // Fire-and-forget
    }
  }
}
