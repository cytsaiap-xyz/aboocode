/**
 * Bundled output styles shipped with aboocode.
 *
 * These cover the three Claude Code defaults: default, concise, and
 * explanatory. Users can override by dropping a file into
 * ~/.aboocode/output-styles/<id>.md with YAML frontmatter (handled by
 * the discovery module below).
 */

import type { OutputStyle } from "./types"

export const DEFAULT_STYLE: OutputStyle = {
  id: "default",
  name: "Default",
  description: "Balanced responses — concise by default but expands when detail is asked for.",
  systemPromptAddendum: `# Output style: default

Keep responses short and focused. Use markdown only when it helps readability (lists for multiple items, code blocks for commands/code). Do not preface answers with summaries of the question or trailing summaries of what you just did — the user can read the diff.`,
}

export const CONCISE_STYLE: OutputStyle = {
  id: "concise",
  name: "Concise",
  description: "One-sentence answers whenever possible. Zero filler, no trailing summaries.",
  systemPromptAddendum: `# Output style: concise

Respond in as few words as possible.
- One-sentence answers are ideal for factual questions.
- No preambles ("I'll check...", "Let me look at..."), no trailing summaries ("I've now done..."), no restating the question.
- Code and commands are fine inline; skip prose around them unless needed for correctness.
- Still explain when an explanation is the answer (e.g. "why is X broken" → short diagnosis).
- Never sacrifice correctness for brevity.`,
  collapseRepeatedReads: true,
}

export const EXPLANATORY_STYLE: OutputStyle = {
  id: "explanatory",
  name: "Explanatory",
  description: "Educational responses with extra context, rationale, and next-step suggestions.",
  systemPromptAddendum: `# Output style: explanatory

When answering, include enough context for a reader who is less familiar with the area to learn from your response.
- Explain *why* the code works the way it does, not just *what* it does.
- When making a change, briefly note alternatives you considered and why you picked this one.
- Cite the source files / functions you looked at so the user can follow along.
- Surface risks and edge cases that the current change does not handle.
- Do NOT over-explain trivial steps — the goal is teaching, not padding.`,
}

export const BUNDLED_STYLES: readonly OutputStyle[] = [DEFAULT_STYLE, CONCISE_STYLE, EXPLANATORY_STYLE]

export function getBundledStyle(id: string): OutputStyle | undefined {
  return BUNDLED_STYLES.find((s) => s.id === id)
}
