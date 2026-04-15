/**
 * Output style types — ported in spirit from claude-code-leak's
 * `src/outputStyles/`.
 *
 * An "output style" is a named persona / response-shape policy that the
 * user can pick for a session (e.g. "default", "concise", "explanatory").
 * The style contributes a block of text that gets appended to the system
 * prompt and can also influence how the TUI renders tool results.
 */

export interface OutputStyle {
  /** Unique id used in config (`output_style: "concise"`). */
  id: string
  /** Short user-facing label. */
  name: string
  /** Longer description shown in the style picker. */
  description: string
  /**
   * Prose appended to the system prompt for sessions using this style.
   * Should be model-facing (second-person instructions).
   */
  systemPromptAddendum: string
  /**
   * If true, collapse repeated read/search tool results into a single
   * block rather than rendering each one. Default false.
   */
  collapseRepeatedReads?: boolean
}
