import { describe, expect, test } from "bun:test"

/**
 * Phase 5: Memory discipline tests.
 *
 * Proves that:
 * 1. DURABLE_MEMORY_TYPES allowlist is explicit and complete
 * 2. validateMemoryContent rejects non-durable content
 * 3. validateMemoryContent keeps durable content
 * 4. Mixed content is partially filtered
 */

describe("Memory Validation", () => {
  describe("DURABLE_MEMORY_TYPES allowlist", () => {
    test("has all required types", async () => {
      const { DURABLE_MEMORY_TYPES } = await import("../../src/memory/extract")
      expect(DURABLE_MEMORY_TYPES).toContain("user_preference")
      expect(DURABLE_MEMORY_TYPES).toContain("user_role")
      expect(DURABLE_MEMORY_TYPES).toContain("feedback")
      expect(DURABLE_MEMORY_TYPES).toContain("project_goal")
      expect(DURABLE_MEMORY_TYPES).toContain("project_decision")
      expect(DURABLE_MEMORY_TYPES).toContain("external_reference")
      expect(DURABLE_MEMORY_TYPES).toContain("workflow")
      expect(DURABLE_MEMORY_TYPES).toContain("lesson_learned")
    })

    test("does NOT include non-durable types", async () => {
      const { DURABLE_MEMORY_TYPES } = await import("../../src/memory/extract")
      const types = DURABLE_MEMORY_TYPES as readonly string[]
      expect(types).not.toContain("architecture")
      expect(types).not.toContain("file_structure")
      expect(types).not.toContain("code_pattern")
      expect(types).not.toContain("session_recap")
      expect(types).not.toContain("dependency")
    })
  })

  describe("validateMemoryContent", () => {
    test("rejects empty content", async () => {
      const { validateMemoryContent } = await import("../../src/memory/extract")
      expect(validateMemoryContent("")).toBeNull()
      expect(validateMemoryContent("   ")).toBeNull()
    })

    test("rejects very short content", async () => {
      const { validateMemoryContent } = await import("../../src/memory/extract")
      expect(validateMemoryContent("ok")).toBeNull()
    })

    test("rejects file structure sections", async () => {
      const { validateMemoryContent } = await import("../../src/memory/extract")
      const content = `## File Structure
src/
  index.ts
  util/
    helpers.ts`
      expect(validateMemoryContent(content)).toBeNull()
    })

    test("rejects architecture overview sections", async () => {
      const { validateMemoryContent } = await import("../../src/memory/extract")
      const content = `## Architecture Overview
The system uses a microservices architecture with the following components...`
      expect(validateMemoryContent(content)).toBeNull()
    })

    test("rejects technology stack sections", async () => {
      const { validateMemoryContent } = await import("../../src/memory/extract")
      const content = `## Tech Stack
- TypeScript 5.x
- Bun runtime
- SQLite via drizzle-orm`
      expect(validateMemoryContent(content)).toBeNull()
    })

    test("rejects coding conventions sections", async () => {
      const { validateMemoryContent } = await import("../../src/memory/extract")
      const content = `## Coding Conventions
- Use camelCase for variables
- Use PascalCase for types`
      expect(validateMemoryContent(content)).toBeNull()
    })

    test("rejects session recap sections", async () => {
      const { validateMemoryContent } = await import("../../src/memory/extract")
      const content = `## Session Summary
In this session we implemented the login feature and fixed 3 bugs.`
      expect(validateMemoryContent(content)).toBeNull()
    })

    test("rejects recent changes sections", async () => {
      const { validateMemoryContent } = await import("../../src/memory/extract")
      const content = `## Recent Changes
- Added auth middleware
- Fixed routing bug
- Updated dependencies`
      expect(validateMemoryContent(content)).toBeNull()
    })

    test("keeps user preference content", async () => {
      const { validateMemoryContent } = await import("../../src/memory/extract")
      const content = `## User Preferences
- Prefers concise responses without trailing summaries
- Likes bundled PRs over many small ones for refactors`
      const result = validateMemoryContent(content)
      expect(result).not.toBeNull()
      expect(result).toContain("Prefers concise responses")
    })

    test("keeps project decision content", async () => {
      const { validateMemoryContent } = await import("../../src/memory/extract")
      const content = `## Key Decisions
- Chose SQLite over Postgres because embedded is simpler for CLI tool distribution
- Auth middleware rewrite driven by legal compliance, not tech debt`
      const result = validateMemoryContent(content)
      expect(result).not.toBeNull()
      expect(result).toContain("SQLite over Postgres")
    })

    test("filters mixed content, keeping only durable sections", async () => {
      const { validateMemoryContent } = await import("../../src/memory/extract")
      const content = `## User Preferences
- User prefers terse responses

## File Structure
src/
  index.ts

## Project Goals
- Ship v1.0 by end of Q2`
      const result = validateMemoryContent(content)
      expect(result).not.toBeNull()
      expect(result).toContain("User prefers terse responses")
      expect(result).toContain("Ship v1.0")
      expect(result).not.toContain("index.ts")
    })
  })
})
