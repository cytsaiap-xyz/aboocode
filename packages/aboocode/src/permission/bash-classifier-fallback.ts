/**
 * Phase 15 (closing): LLM fallback for the Bash classifier.
 *
 * When the pattern-based classifier flags `needsFallback: true` (because
 * the command contains command substitution, eval, exec, or other
 * features the regex layer can't see through), this module asks a small
 * fast model for a final verdict.
 *
 * Strict contract: the LLM is told to respond with one of the four
 * verdicts and nothing else. Any other response (or any error) falls
 * back to the structural verdict — we never relax safety because the
 * LLM was indecisive.
 */

import { generateObject, type LanguageModel } from "ai"
import { z } from "zod"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import type { BashClass, BashClassification } from "./bash-classifier"

const log = Log.create({ service: "permission.bash-classifier-fallback" })

const SCHEMA = z.object({
  verdict: z.enum(["safe", "readonly", "destructive", "dangerous"]),
  reason: z.string().max(200),
})

const SYSTEM_PROMPT = `You are a security classifier for shell commands. Read the command, classify it as exactly one of:

  - safe:        purely read-only, no network, no fs/env/process changes
  - readonly:    reads but may exfiltrate (curl, wget, dig)
  - destructive: mutates the local environment (rm, mv, chmod, sed -i, package installs, git mutations)
  - dangerous:   could do serious harm (rm -rf /, sudo, pipe-to-shell, dd to disk, force-push to main, fork bombs)

When in doubt between two classes, pick the more restrictive one. Reply with structured JSON only — verdict + a short reason.`

const ORDER: Record<BashClass, number> = { safe: 0, readonly: 1, destructive: 2, dangerous: 3 }

export interface FallbackInput {
  command: string
  classification: BashClassification
  signal: AbortSignal
}

export interface FallbackResult {
  verdict: BashClass
  reason: string
  source: "llm" | "structural"
}

/**
 * Ask the LLM to classify the command. Returns the LLM verdict if it's
 * AT LEAST as restrictive as the structural verdict; otherwise we keep
 * the structural verdict (defense in depth).
 */
export async function llmFallback(input: FallbackInput): Promise<FallbackResult> {
  const structural = input.classification.verdict
  const language = await resolveSmallLanguageModel()
  if (!language) {
    return { verdict: structural, reason: "no small model available", source: "structural" }
  }
  try {
    const result = await generateObject({
      model: language,
      system: SYSTEM_PROMPT,
      schema: SCHEMA,
      schemaName: "BashVerdict",
      schemaDescription: "Security verdict for a shell command",
      prompt: [
        `Command: ${input.command}`,
        ``,
        `Structural pre-classification: ${structural}`,
        `Reasons:`,
        ...input.classification.reasons.map((r) => `  - ${r}`),
        ``,
        `Refine the verdict. If the structural reading missed something dangerous, escalate. Never de-escalate below the structural verdict.`,
      ].join("\n"),
      abortSignal: input.signal,
    })
    const llmVerdict = result.object.verdict
    // Defense in depth: take the more restrictive of structural vs LLM.
    const finalVerdict = ORDER[llmVerdict] >= ORDER[structural] ? llmVerdict : structural
    return {
      verdict: finalVerdict,
      reason: result.object.reason,
      source: "llm",
    }
  } catch (e) {
    if (input.signal.aborted) {
      return { verdict: structural, reason: "aborted", source: "structural" }
    }
    log.warn("llm fallback failed, keeping structural verdict", { error: e })
    return { verdict: structural, reason: "llm error", source: "structural" }
  }
}

async function resolveSmallLanguageModel(): Promise<LanguageModel | null> {
  try {
    const config = await Config.get()
    const primary = config.model
    if (!primary) return null
    const parsed = Provider.parseModel(primary)
    const small =
      (await Provider.getSmallModel(parsed.providerID)) ??
      (await Provider.getModel(parsed.providerID, parsed.modelID))
    if (!small) return null
    return await Provider.getLanguage(small)
  } catch (e) {
    log.warn("resolveSmallLanguageModel failed", { error: e })
    return null
  }
}
