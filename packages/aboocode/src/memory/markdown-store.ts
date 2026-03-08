import path from "path"
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { UsageLog } from "@/usage-log"
import { DebugLog } from "@/debug-log"

const log = Log.create({ service: "memory.markdown-store" })

export namespace MarkdownStore {
  export function getDir(projectID?: string): string {
    const pid = projectID ?? Instance.project.id
    const dir = path.join(Global.Path.data, "memory", pid)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  export function getMemoryPath(projectID?: string): string {
    return path.join(getDir(projectID), "MEMORY.md")
  }

  export function readMemory(projectID?: string): string {
    UsageLog.record("memory.markdown-store", "readMemory")
    const filePath = getMemoryPath(projectID)
    if (!existsSync(filePath)) return ""
    try {
      const content = readFileSync(filePath, "utf-8")
      DebugLog.memoryStoreRead(filePath, content.length)
      return content
    } catch (e) {
      log.error("failed to read MEMORY.md", { path: filePath, error: e })
      return ""
    }
  }

  export function writeMemory(content: string, projectID?: string): void {
    UsageLog.record("memory.markdown-store", "writeMemory", { contentLength: content.length })
    const filePath = getMemoryPath(projectID)
    const dir = path.dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    try {
      writeFileSync(filePath, content, "utf-8")
      DebugLog.memoryStoreWrite(filePath, content.length)
    } catch (e) {
      log.error("failed to write MEMORY.md", { path: filePath, error: e })
      throw e
    }
  }

  export function listTopicFiles(projectID?: string): string[] {
    UsageLog.record("memory.markdown-store", "listTopicFiles")
    const dir = getDir(projectID)
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
        .sort()
    } catch {
      return []
    }
  }

  export function readTopicFile(name: string, projectID?: string): string {
    UsageLog.record("memory.markdown-store", "readTopicFile", { name })
    const filePath = path.join(getDir(projectID), name)
    if (!existsSync(filePath)) return ""
    try {
      return readFileSync(filePath, "utf-8")
    } catch (e) {
      log.error("failed to read topic file", { path: filePath, error: e })
      return ""
    }
  }

  export function writeTopicFile(name: string, content: string, projectID?: string): void {
    UsageLog.record("memory.markdown-store", "writeTopicFile", { name })
    const filePath = path.join(getDir(projectID), name)
    try {
      writeFileSync(filePath, content, "utf-8")
    } catch (e) {
      log.error("failed to write topic file", { path: filePath, error: e })
      throw e
    }
  }
}
