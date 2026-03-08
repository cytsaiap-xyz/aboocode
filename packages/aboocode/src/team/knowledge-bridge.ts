import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { Log } from "../util/log"
import { UsageLog } from "../usage-log"
import path from "path"

export namespace KnowledgeBridge {
  const log = Log.create({ service: "team.knowledge-bridge" })

  // Standard knowledge file names to look for in project
  const KNOWLEDGE_FILES = [
    "AGENTS.md",
    "CLAUDE.md",
    "CONTRIBUTING.md",
    "ARCHITECTURE.md",
    ".aboocode/AGENTS.md",
    ".aboocode/knowledge.md",
  ]

  export async function loadKnowledgeContext(): Promise<string[]> {
    const context: string[] = []

    for (const file of KNOWLEDGE_FILES) {
      const filePath = path.join(Instance.worktree, file)
      const content = await Filesystem.readText(filePath).catch(() => undefined)
      if (content) {
        context.push(`## ${file}\n${content}`)
        log.info("loaded knowledge file", { file })
      }
    }

    UsageLog.record("team.knowledge-bridge", "loadKnowledgeContext", { filesLoaded: context.length })
    return context
  }

  export function buildOrchestratorKnowledgeSection(knowledgeContext: string[]): string {
    if (knowledgeContext.length === 0) {
      return "No project knowledge files found."
    }

    return [
      "The following project knowledge files are available. Use this context when creating agents and assigning tasks:",
      "",
      ...knowledgeContext,
    ].join("\n")
  }

  export function buildWorkerRecordingInstructions(): string {
    return [
      "## Recording Instructions",
      "When you complete your task, provide a summary including:",
      "- Files created or modified",
      "- Key decisions made",
      "- Any issues encountered",
      "- Dependencies on other work",
    ].join("\n")
  }
}
