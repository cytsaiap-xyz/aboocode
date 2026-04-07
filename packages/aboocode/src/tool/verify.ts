import z from "zod"
import { Tool } from "./tool"

/**
 * Phase 10: VerifyTool
 *
 * Triggers the verification agent to independently check work correctness.
 * The verify agent has read-only access and reports PASS/FAIL/PARTIAL
 * with command output as evidence.
 */
export const VerifyTool = Tool.define<
  z.ZodObject<{
    description: z.ZodString
    checks: z.ZodOptional<z.ZodArray<z.ZodString>>
  }>,
  {}
>("verify", {
  description:
    "Launch the verification agent to independently check that your work is correct. The verify agent runs actual commands and reports PASS/FAIL/PARTIAL with evidence. Use this before marking complex tasks as complete.",
  parameters: z.object({
    description: z.string().describe("Description of what was done and what should be verified"),
    checks: z
      .array(z.string())
      .optional()
      .describe("Specific checks to run (e.g., 'tests pass', 'file exists', 'no type errors')"),
  }),
  async execute(args, ctx) {
    const checksText = args.checks?.length
      ? `\n\nSpecific checks to verify:\n${args.checks.map((c) => `- ${c}`).join("\n")}`
      : ""

    return {
      title: "Verification requested",
      metadata: {},
      output: [
        `Verification request created for: ${args.description}`,
        checksText,
        "",
        "To run verification, use the task tool with subagent_type: 'verify' and this description as the prompt.",
      ].join("\n"),
    }
  },
})
