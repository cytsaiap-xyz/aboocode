import { describe, test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { KnowledgeBridge } from "../../src/team/knowledge-bridge"

describe("KnowledgeBridge", () => {
  test("loadKnowledgeContext returns empty array when no knowledge files exist", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const context = await KnowledgeBridge.loadKnowledgeContext()
        expect(context).toEqual([])
      },
    })
  })

  test("buildOrchestratorKnowledgeSection returns 'no files' message when empty", () => {
    const result = KnowledgeBridge.buildOrchestratorKnowledgeSection([])
    expect(result).toBe("No project knowledge files found.")
  })

  test("buildOrchestratorKnowledgeSection includes knowledge context entries", () => {
    const context = ["## AGENTS.md\n# Agent rules", "## CONTRIBUTING.md\n# Contributing guidelines"]
    const result = KnowledgeBridge.buildOrchestratorKnowledgeSection(context)
    expect(result).toContain("project knowledge files are available")
    expect(result).toContain("AGENTS.md")
    expect(result).toContain("Agent rules")
    expect(result).toContain("CONTRIBUTING.md")
    expect(result).toContain("Contributing guidelines")
  })

  test("buildOrchestratorKnowledgeSection preserves all entries", () => {
    const context = [
      "## AGENTS.md\nContent A",
      "## ARCHITECTURE.md\nContent B",
      "## CLAUDE.md\nContent C",
    ]
    const result = KnowledgeBridge.buildOrchestratorKnowledgeSection(context)
    expect(result).toContain("Content A")
    expect(result).toContain("Content B")
    expect(result).toContain("Content C")
  })

  test("buildWorkerRecordingInstructions returns recording instructions", () => {
    const result = KnowledgeBridge.buildWorkerRecordingInstructions()
    expect(result).toContain("Recording Instructions")
    expect(result).toContain("Files created or modified")
    expect(result).toContain("Key decisions made")
    expect(result).toContain("issues encountered")
    expect(result).toContain("Dependencies on other work")
  })

  test("buildWorkerRecordingInstructions returns multi-line content", () => {
    const result = KnowledgeBridge.buildWorkerRecordingInstructions()
    expect(result.length).toBeGreaterThan(0)
    expect(result.split("\n").length).toBeGreaterThanOrEqual(5)
  })

  test("all KnowledgeBridge functions are exported", () => {
    expect(typeof KnowledgeBridge.loadKnowledgeContext).toBe("function")
    expect(typeof KnowledgeBridge.buildOrchestratorKnowledgeSection).toBe("function")
    expect(typeof KnowledgeBridge.buildWorkerRecordingInstructions).toBe("function")
  })
})
