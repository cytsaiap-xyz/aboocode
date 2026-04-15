import { describe, test, expect } from "bun:test"

/**
 * Phase 1 memdir parity tests.
 *
 * Validates that each ported module from claude-code-leak/src/memdir/
 * exposes the expected public surface and the pure functions behave
 * correctly. These tests are pure / deterministic — no network, no LLM
 * calls — so they run in every environment.
 */

describe("memdir: memoryAge", () => {
  test("memoryAgeDays returns 0 for today", async () => {
    const { memoryAgeDays } = await import("../../src/memory/memdir/memoryAge")
    expect(memoryAgeDays(Date.now())).toBe(0)
  })

  test("memoryAgeDays clamps negative (future) inputs to 0", async () => {
    const { memoryAgeDays } = await import("../../src/memory/memdir/memoryAge")
    expect(memoryAgeDays(Date.now() + 86_400_000)).toBe(0)
  })

  test("memoryAge returns yesterday for ~1 day old", async () => {
    const { memoryAge } = await import("../../src/memory/memdir/memoryAge")
    expect(memoryAge(Date.now() - 86_400_000 - 1)).toBe("yesterday")
  })

  test("memoryAge returns '5 days ago' for 5-day-old", async () => {
    const { memoryAge } = await import("../../src/memory/memdir/memoryAge")
    const fiveDays = Date.now() - 5 * 86_400_000 - 1000
    expect(memoryAge(fiveDays)).toBe("5 days ago")
  })

  test("memoryFreshnessText is empty for fresh memories", async () => {
    const { memoryFreshnessText } = await import("../../src/memory/memdir/memoryAge")
    expect(memoryFreshnessText(Date.now())).toBe("")
    expect(memoryFreshnessText(Date.now() - 1000)).toBe("")
  })

  test("memoryFreshnessText warns for stale memories", async () => {
    const { memoryFreshnessText } = await import("../../src/memory/memdir/memoryAge")
    const fortyDays = Date.now() - 40 * 86_400_000
    const text = memoryFreshnessText(fortyDays)
    expect(text).toContain("40 days old")
    expect(text).toContain("point-in-time")
  })

  test("memoryFreshnessNote wraps stale caveat in system-reminder tags", async () => {
    const { memoryFreshnessNote } = await import("../../src/memory/memdir/memoryAge")
    const note = memoryFreshnessNote(Date.now() - 10 * 86_400_000)
    expect(note).toContain("<system-reminder>")
    expect(note).toContain("</system-reminder>")
    expect(note).toContain("10 days old")
  })
})

describe("memdir: memoryTypes", () => {
  test("MEMORY_TYPES has exactly 4 entries", async () => {
    const { MEMORY_TYPES } = await import("../../src/memory/memdir/memoryTypes")
    expect(MEMORY_TYPES).toEqual(["user", "feedback", "project", "reference"])
  })

  test("parseMemoryType accepts valid types", async () => {
    const { parseMemoryType } = await import("../../src/memory/memdir/memoryTypes")
    expect(parseMemoryType("user")).toBe("user")
    expect(parseMemoryType("feedback")).toBe("feedback")
    expect(parseMemoryType("project")).toBe("project")
    expect(parseMemoryType("reference")).toBe("reference")
  })

  test("parseMemoryType rejects invalid input", async () => {
    const { parseMemoryType } = await import("../../src/memory/memdir/memoryTypes")
    expect(parseMemoryType("invalid")).toBeUndefined()
    expect(parseMemoryType(42)).toBeUndefined()
    expect(parseMemoryType(undefined)).toBeUndefined()
    expect(parseMemoryType(null)).toBeUndefined()
  })

  test("TYPES_SECTION_INDIVIDUAL omits scope tags", async () => {
    const { TYPES_SECTION_INDIVIDUAL } = await import("../../src/memory/memdir/memoryTypes")
    const text = TYPES_SECTION_INDIVIDUAL.join("\n")
    expect(text).not.toContain("<scope>")
    expect(text).toContain("<name>user</name>")
    expect(text).toContain("<name>feedback</name>")
    expect(text).toContain("<name>project</name>")
    expect(text).toContain("<name>reference</name>")
  })

  test("TYPES_SECTION_COMBINED includes scope tags", async () => {
    const { TYPES_SECTION_COMBINED } = await import("../../src/memory/memdir/memoryTypes")
    const text = TYPES_SECTION_COMBINED.join("\n")
    expect(text).toContain("<scope>")
    expect(text).toContain("always private")
  })

  test("WHAT_NOT_TO_SAVE_SECTION forbids derivable content", async () => {
    const { WHAT_NOT_TO_SAVE_SECTION } = await import("../../src/memory/memdir/memoryTypes")
    const text = WHAT_NOT_TO_SAVE_SECTION.join("\n")
    expect(text.toLowerCase()).toContain("file paths")
    expect(text.toLowerCase()).toContain("git history")
    expect(text.toLowerCase()).toContain("architecture")
  })
})

describe("memdir: truncation", () => {
  test("short content passes through unchanged", async () => {
    const { truncateEntrypointContent } = await import("../../src/memory/memdir/memdir")
    const result = truncateEntrypointContent("line one\nline two\n")
    expect(result.wasLineTruncated).toBe(false)
    expect(result.wasByteTruncated).toBe(false)
    expect(result.content).toBe("line one\nline two")
  })

  test("line-truncates when >200 lines", async () => {
    const { truncateEntrypointContent, MAX_ENTRYPOINT_LINES } = await import("../../src/memory/memdir/memdir")
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`)
    const result = truncateEntrypointContent(lines.join("\n"))
    expect(result.wasLineTruncated).toBe(true)
    expect(result.lineCount).toBe(250)
    expect(result.content).toContain(`line ${MAX_ENTRYPOINT_LINES - 1}`)
    expect(result.content).toContain("WARNING")
    expect(result.content).toContain(`${MAX_ENTRYPOINT_LINES}`)
  })

  test("byte-truncates when over byte cap", async () => {
    const { truncateEntrypointContent } = await import("../../src/memory/memdir/memdir")
    // 10 lines, but each line is 5000 chars → over the 25000 byte cap
    const giantLine = "x".repeat(5000)
    const raw = Array.from({ length: 10 }, () => giantLine).join("\n")
    const result = truncateEntrypointContent(raw)
    expect(result.wasByteTruncated).toBe(true)
    expect(result.content.length).toBeLessThan(30_000)
    expect(result.content).toContain("WARNING")
  })
})

describe("memdir: memoryScan formatMemoryManifest", () => {
  test("formats entries with type tag and description", async () => {
    const { formatMemoryManifest } = await import("../../src/memory/memdir/memoryScan")
    const result = formatMemoryManifest([
      {
        filename: "user_role.md",
        filePath: "/tmp/memory/user_role.md",
        mtimeMs: new Date("2026-04-01T00:00:00Z").getTime(),
        description: "the user is a senior backend engineer",
        type: "user",
      },
      {
        filename: "feedback_testing.md",
        filePath: "/tmp/memory/feedback_testing.md",
        mtimeMs: new Date("2026-04-02T00:00:00Z").getTime(),
        description: null,
        type: "feedback",
      },
    ])
    expect(result).toContain("[user] user_role.md")
    expect(result).toContain("the user is a senior backend engineer")
    expect(result).toContain("[feedback] feedback_testing.md")
  })

  test("omits type tag when type is undefined", async () => {
    const { formatMemoryManifest } = await import("../../src/memory/memdir/memoryScan")
    const result = formatMemoryManifest([
      {
        filename: "legacy.md",
        filePath: "/tmp/legacy.md",
        mtimeMs: Date.now(),
        description: "no type",
        type: undefined,
      },
    ])
    expect(result).not.toContain("[undefined]")
    expect(result).toContain("legacy.md")
  })
})

describe("memdir: bundled output styles", () => {
  test("BUNDLED_STYLES has default, concise, explanatory", async () => {
    const { BUNDLED_STYLES } = await import("../../src/format/output-styles/bundled")
    const ids = BUNDLED_STYLES.map((s) => s.id)
    expect(ids).toContain("default")
    expect(ids).toContain("concise")
    expect(ids).toContain("explanatory")
  })

  test("each bundled style has non-empty prompt addendum", async () => {
    const { BUNDLED_STYLES } = await import("../../src/format/output-styles/bundled")
    for (const style of BUNDLED_STYLES) {
      expect(style.systemPromptAddendum.trim().length).toBeGreaterThan(20)
    }
  })
})

describe("memdir: permission mode", () => {
  test("default falls through", async () => {
    const { PermissionMode } = await import("../../src/permission/mode")
    PermissionMode.setMode(undefined)
    delete process.env.ABOOCODE_PERMISSION_MODE
    expect(PermissionMode.apply("write")).toBe("fallthrough")
    expect(PermissionMode.apply("bash")).toBe("fallthrough")
  })

  test("bypassPermissions allows everything", async () => {
    const { PermissionMode } = await import("../../src/permission/mode")
    PermissionMode.setMode("bypassPermissions")
    expect(PermissionMode.apply("write")).toBe("allow")
    expect(PermissionMode.apply("bash")).toBe("allow")
    PermissionMode.setMode(undefined)
  })

  test("acceptEdits allows writes only", async () => {
    const { PermissionMode } = await import("../../src/permission/mode")
    PermissionMode.setMode("acceptEdits")
    expect(PermissionMode.apply("write")).toBe("allow")
    expect(PermissionMode.apply("edit")).toBe("allow")
    expect(PermissionMode.apply("notebook_edit")).toBe("allow")
    expect(PermissionMode.apply("bash")).toBe("fallthrough")
    PermissionMode.setMode(undefined)
  })

  test("plan denies side-effecting permissions", async () => {
    const { PermissionMode } = await import("../../src/permission/mode")
    PermissionMode.setMode("plan")
    expect(PermissionMode.apply("write")).toBe("deny")
    expect(PermissionMode.apply("edit")).toBe("deny")
    expect(PermissionMode.apply("bash")).toBe("deny")
    expect(PermissionMode.apply("webfetch")).toBe("deny")
    expect(PermissionMode.apply("read")).toBe("fallthrough")
    expect(PermissionMode.apply("grep")).toBe("fallthrough")
    PermissionMode.setMode(undefined)
  })
})

describe("memdir: compaction strategy selector", () => {
  test("selects none under 75% of budget", async () => {
    const { CompactionStrategies } = await import("../../src/session/compaction-strategies")
    const strategy = await CompactionStrategies.selectStrategy({
      used: 50_000,
      limit: 200_000,
      reserved: 20_000,
      usable: 180_000,
      ratio: 0.28,
    })
    expect(strategy).toBe("none")
  })

  test("selects microcompact between 75-85%", async () => {
    const { CompactionStrategies } = await import("../../src/session/compaction-strategies")
    const strategy = await CompactionStrategies.selectStrategy({
      used: 144_000,
      limit: 200_000,
      reserved: 20_000,
      usable: 180_000,
      ratio: 0.8,
    })
    expect(strategy).toBe("microcompact")
  })

  test("selects snip between 85-92%", async () => {
    const { CompactionStrategies } = await import("../../src/session/compaction-strategies")
    const strategy = await CompactionStrategies.selectStrategy({
      used: 160_000,
      limit: 200_000,
      reserved: 20_000,
      usable: 180_000,
      ratio: 0.89,
    })
    expect(strategy).toBe("snip")
  })

  test("selects reactive between 92-97%", async () => {
    const { CompactionStrategies } = await import("../../src/session/compaction-strategies")
    const strategy = await CompactionStrategies.selectStrategy({
      used: 170_000,
      limit: 200_000,
      reserved: 20_000,
      usable: 180_000,
      ratio: 0.94,
    })
    expect(strategy).toBe("reactive")
  })

  test("selects summarize at ≥97%", async () => {
    const { CompactionStrategies } = await import("../../src/session/compaction-strategies")
    const strategy = await CompactionStrategies.selectStrategy({
      used: 177_000,
      limit: 200_000,
      reserved: 20_000,
      usable: 180_000,
      ratio: 0.983,
    })
    expect(strategy).toBe("summarize")
  })
})

describe("memdir: bundled skills", () => {
  test("BUNDLED_SKILLS includes commit, review, test, plan", async () => {
    const { BUNDLED_SKILLS } = await import("../../src/skill/bundled")
    const names = BUNDLED_SKILLS.map((s) => s.name)
    expect(names).toContain("commit")
    expect(names).toContain("review")
    expect(names).toContain("test")
    expect(names).toContain("plan")
  })

  test("commit skill content forbids --no-verify and git add -A", async () => {
    const { getBundledSkill } = await import("../../src/skill/bundled")
    const commit = getBundledSkill("commit")
    expect(commit).toBeDefined()
    expect(commit!.content).toContain("--no-verify")
    expect(commit!.content).toContain("git add -A")
  })
})

describe("memdir: Claude Code mcp.json compat", () => {
  test("candidatePaths includes project and home directories", async () => {
    const { candidatePaths } = await import("../../src/mcp/claude-code-compat")
    const paths = candidatePaths("/tmp/test-project")
    expect(paths.some((p) => p.endsWith("/.mcp.json"))).toBe(true)
    expect(paths.some((p) => p.endsWith("/.claude.json"))).toBe(true)
  })

  test("loadFromFile returns empty map for missing file", async () => {
    const { loadFromFile } = await import("../../src/mcp/claude-code-compat")
    const result = await loadFromFile("/nonexistent/does-not-exist.mcp.json")
    expect(result).toEqual({})
  })
})
