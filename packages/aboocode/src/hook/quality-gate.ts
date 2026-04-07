import { Config } from "@/config/config"
import { Log } from "@/util/log"
import { MessageV2 } from "@/session/message-v2"

export namespace QualityGate {
  const log = Log.create({ service: "hook.quality-gate" })

  export interface GateConfig {
    requireBuild: boolean
    requireTests: boolean
    requireVerification: boolean
    requireLint: boolean
  }

  export interface StopContext {
    sessionID: string
    agent: string
    reason: string
  }

  export interface StopDecision {
    action: "proceed" | "block"
    message?: string
  }

  /**
   * Task verification levels — classifies tasks by required verification rigor.
   * Reference: ai-agent-deep-dive/docs/08-agent-runtime-loop.md
   */
  export type VerificationLevel = "none" | "recommended" | "required"

  /**
   * Classify a task's verification level based on what tools were used.
   * - exploration (only reads) → none
   * - planning (no edits) → none
   * - implementation (writes/edits) → recommended
   * - risky implementation (bash mutations, apply_patch) → required
   */
  export async function classifyTask(sessionID: string): Promise<{
    level: VerificationLevel
    hasWrites: boolean
    hasBashMutations: boolean
    hasTests: boolean
  }> {
    let hasWrites = false
    let hasBashMutations = false
    let hasTests = false
    const mutationPatterns = /\b(rm|mv|cp|mkdir|chmod|git\s+(push|commit|merge|rebase|reset|checkout)|DROP|DELETE|ALTER)\b/i

    for await (const msg of MessageV2.stream(sessionID)) {
      for (const part of msg.parts) {
        if (part.type !== "tool" || part.state.status !== "completed") continue
        const tp = part as MessageV2.ToolPart

        if (tp.tool === "write" || tp.tool === "edit" || tp.tool === "apply_patch" || tp.tool === "multiedit") {
          hasWrites = true
        }

        if (tp.tool === "bash") {
          const cmd = typeof tp.state.input === "object" && tp.state.input !== null
            ? String((tp.state.input as Record<string, unknown>).command ?? "")
            : ""
          if (mutationPatterns.test(cmd)) hasBashMutations = true
          if (/\b(test|jest|vitest|pytest|cargo test|go test|bun test)\b/i.test(cmd)) hasTests = true
        }
      }
    }

    let level: VerificationLevel = "none"
    if (hasBashMutations) level = "required"
    else if (hasWrites) level = "recommended"

    return { level, hasWrites, hasBashMutations, hasTests }
  }

  /**
   * Scan session history to determine which quality gates have already been satisfied.
   * Looks at bash tool calls and verification subagent completions.
   */
  async function scanSatisfiedGates(sessionID: string): Promise<{
    buildPassed: boolean
    testsPassed: boolean
    verificationRan: boolean
    lintPassed: boolean
  }> {
    let buildPassed = false
    let testsPassed = false
    let verificationRan = false
    let lintPassed = false

    const buildPatterns = /\b(make|build|compile|tsc|bun build|npm run build|cargo build|go build|gradle build|mvn compile)\b/i
    const testPatterns = /\b(test|jest|vitest|mocha|pytest|cargo test|go test|bun test|npm test|npm run test)\b/i
    const lintPatterns = /\b(lint|eslint|biome|prettier|clippy|golint|flake8|ruff|npm run lint)\b/i

    for await (const msg of MessageV2.stream(sessionID)) {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.state.status === "completed") {
          // Check bash tool calls for build/test/lint commands
          if (part.tool === "bash") {
            const cmd = typeof part.state.input === "object" && part.state.input !== null
              ? (part.state.input as Record<string, unknown>).command ?? ""
              : ""
            const cmdStr = String(cmd)
            const output = String(part.state.output ?? "").toLowerCase()
            const exitStatus = part.state.metadata?.exit
            const isError = typeof exitStatus === "number" ? exitStatus !== 0 : (output.includes("error") && output.includes("failed"))

            if (buildPatterns.test(cmdStr) && !isError) buildPassed = true
            if (testPatterns.test(cmdStr) && !isError) testsPassed = true
            if (lintPatterns.test(cmdStr) && !isError) lintPassed = true
          }

          // Check for verification subagent completion
          if (part.tool === "task") {
            const input = part.state.input as Record<string, unknown> | undefined
            if (input?.subagent_type === "verification") {
              const output = String(part.state.output ?? "")
              if (output.includes("PASS") || output.includes("verdict")) {
                verificationRan = true
              }
            }
          }
        }

        // Also check for task notifications from background verification
        if (part.type === "text" && part.synthetic) {
          const text = part.text ?? ""
          if (text.includes("task-notification") && text.includes("verification") && text.includes("completed")) {
            verificationRan = true
          }
        }
      }
    }

    return { buildPassed, testsPassed, verificationRan, lintPassed }
  }

  /**
   * Evaluate quality gates before allowing session completion.
   *
   * Two layers of enforcement:
   * 1. Explicit config gates (stopHooks) — always enforced when configured
   * 2. Automatic verification policy — based on task classification
   *    (risky tasks require verification even without explicit config)
   *
   * Reference: ai-agent-deep-dive/docs/08-agent-runtime-loop.md
   */
  export async function evaluate(context: StopContext): Promise<StopDecision> {
    const config = await Config.get()
    const gates = config.stopHooks as GateConfig | undefined

    // If stopping due to error, skip quality gates
    if (context.reason === "error") return { action: "proceed" }

    const blocks: string[] = []

    // Layer 1: Explicit config gates
    if (gates) {
      const satisfied = await scanSatisfiedGates(context.sessionID)

      if (gates.requireBuild && !satisfied.buildPassed) {
        blocks.push("Build verification has not been confirmed. Run the build command and verify it passes before completing.")
      }

      if (gates.requireTests && !satisfied.testsPassed) {
        blocks.push("Test suite has not been confirmed passing. Run tests and verify they pass before completing.")
      }

      if (gates.requireVerification && !satisfied.verificationRan) {
        blocks.push(
          'Independent verification has not been run. Use the task tool with subagent_type: "verification" to verify your work before completing.',
        )
      }

      if (gates.requireLint && !satisfied.lintPassed) {
        blocks.push("Lint check has not been confirmed passing. Run the linter and verify it passes before completing.")
      }
    }

    // Layer 2: Automatic verification policy based on task classification
    // Only applies to build/general agents that perform implementation work
    if (context.agent === "build" || context.agent === "general") {
      const classification = await classifyTask(context.sessionID)
      log.info("task classification", { sessionID: context.sessionID, ...classification })

      if (classification.level === "required" && !classification.hasTests) {
        // Risky tasks (bash mutations) require verification or tests
        const satisfied = await scanSatisfiedGates(context.sessionID)
        if (!satisfied.verificationRan && !satisfied.testsPassed) {
          blocks.push(
            "This task performed risky operations (shell mutations). Run tests or verification before completing.",
          )
        }
      }
    }

    if (blocks.length === 0) {
      log.info("all quality gates satisfied", { sessionID: context.sessionID })
      return { action: "proceed" }
    }

    log.info("quality gate blocking completion", {
      sessionID: context.sessionID,
      blockCount: blocks.length,
    })

    return {
      action: "block",
      message: [
        "<quality-gate>",
        "You cannot complete yet. The following quality gates must be satisfied:",
        "",
        ...blocks.map((b, i) => `${i + 1}. ${b}`),
        "",
        "Please address these requirements and then try to complete again.",
        "</quality-gate>",
      ].join("\n"),
    }
  }
}
