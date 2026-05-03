/**
 * Auto-skill activation — surface relevant skills based on user prompt.
 *
 * Phase 13.6: rather than require the model to remember `Skill(...)`
 * incantations, scan the user's prompt for keywords that overlap with
 * each registered skill's name + description. When a strong match
 * lands, prepend a `<system-reminder>` recommending the skill (with
 * the skill name spelled out so the model can call it directly).
 *
 * This is *advisory*: the auto-activator never invokes the skill
 * itself. It only nudges the model to consider it. False positives
 * are cheap (the model ignores irrelevant suggestions); false
 * negatives mean the model proceeds without the hint, which matches
 * today's behavior.
 *
 * Matching algorithm:
 *   - Tokenize the user prompt into lowercase words ≥ 4 chars
 *   - Tokenize each skill's name + description the same way
 *   - Score = number of skill tokens present in the prompt
 *   - A skill scores ≥ 2 OR has its exact name in the prompt → activated
 *   - Return up to 3 activated skills, ranked by score
 */

import { Skill } from "./skill"

const STOPWORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "into",
  "your",
  "have",
  "been",
  "will",
  "they",
  "them",
  "what",
  "when",
  "where",
  "which",
  "while",
  "would",
  "could",
  "should",
  "about",
  "their",
  "there",
  "these",
  "those",
  "some",
  "after",
  "before",
  "because",
  "tool",
  "tools",
  "skill",
  "skills",
  "agent",
  "code",
  "file",
  "files",
])

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
}

export interface ActivatedSkill {
  name: string
  description: string
  score: number
  reason: string
}

const MAX_SUGGESTIONS = 3
const MIN_SCORE = 2

export namespace AutoActivate {
  /**
   * Scan the prompt for skills worth surfacing. Returns at most 3,
   * ranked by score. Returns [] if no skill scores high enough or if
   * the prompt is empty.
   */
  export async function scan(prompt: string): Promise<ActivatedSkill[]> {
    if (!prompt || prompt.trim().length < 10) return []

    const skills = await Skill.all().catch(() => [] as Skill.Info[])
    if (skills.length === 0) return []

    const promptTokens = new Set(tokenize(prompt))
    if (promptTokens.size === 0) return []

    const promptLower = prompt.toLowerCase()
    const matches: ActivatedSkill[] = []
    for (const skill of skills) {
      const skillTokens = new Set(tokenize(`${skill.name} ${skill.description}`))
      let score = 0
      const matched: string[] = []
      for (const t of skillTokens) {
        if (promptTokens.has(t)) {
          score++
          matched.push(t)
        }
      }
      // Exact name appearance is a strong signal — bump the score so
      // even short-named skills can activate.
      if (promptLower.includes(skill.name.toLowerCase())) score += 3

      if (score >= MIN_SCORE) {
        matches.push({
          name: skill.name,
          description: skill.description,
          score,
          reason: matched.length > 0 ? `keyword overlap: ${matched.slice(0, 5).join(", ")}` : "skill name in prompt",
        })
      }
    }
    matches.sort((a, b) => b.score - a.score)
    return matches.slice(0, MAX_SUGGESTIONS)
  }

  /**
   * Build a `<system-reminder>` snippet ready to prepend to the user
   * message. Returns "" if nothing activated (caller can no-op).
   */
  export async function buildReminder(prompt: string): Promise<string> {
    const activated = await scan(prompt)
    if (activated.length === 0) return ""
    const lines = [
      "Available skills that may apply to this turn (call via the Skill tool if useful):",
      ...activated.map((s) => `  - **${s.name}** — ${s.description} (${s.reason})`),
    ]
    return lines.join("\n")
  }
}
