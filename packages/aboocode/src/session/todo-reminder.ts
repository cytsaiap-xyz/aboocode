import { Todo } from "./todo"

/**
 * Long tasks drift: the model stops maintaining its todo list and loses the
 * thread. Every loop step ticks a per-session counter; once the model has
 * gone TURNS_SINCE_WRITE steps without a todowrite (and at least
 * TURNS_BETWEEN_REMINDERS since the last nudge), build() returns an
 * ephemeral <system-reminder> carrying the current list.
 */
export namespace TodoReminder {
  export const TURNS_SINCE_WRITE = 10
  export const TURNS_BETWEEN_REMINDERS = 10

  interface State {
    sinceWrite: number
    sinceReminder: number
  }
  const sessions = new Map<string, State>()

  function get(sessionID: string): State {
    const existing = sessions.get(sessionID)
    if (existing) return existing
    const created = { sinceWrite: 0, sinceReminder: TURNS_BETWEEN_REMINDERS }
    sessions.set(sessionID, created)
    return created
  }

  export function tick(sessionID: string) {
    const state = get(sessionID)
    state.sinceWrite++
    state.sinceReminder++
  }

  export function recordWrite(sessionID: string) {
    const state = get(sessionID)
    state.sinceWrite = 0
  }

  export function markReminded(sessionID: string) {
    const state = get(sessionID)
    state.sinceReminder = 0
  }

  export function due(sessionID: string) {
    const state = sessions.get(sessionID)
    if (!state) return false
    return state.sinceWrite >= TURNS_SINCE_WRITE && state.sinceReminder >= TURNS_BETWEEN_REMINDERS
  }

  export function reset(sessionID: string) {
    sessions.delete(sessionID)
  }

  /** Returns reminder text when due and the session has open todos, else undefined. */
  export async function build(sessionID: string): Promise<string | undefined> {
    if (!due(sessionID)) return undefined
    const todos = await Todo.get(sessionID)
    const open = todos.filter((t) => t.status !== "completed")
    if (open.length === 0) return undefined
    markReminded(sessionID)
    return [
      "<system-reminder>",
      "It has been a while since the todo list was updated. Review it, mark finished items completed, and make sure your current work still matches it. Do not mention this reminder to the user.",
      "",
      "Current todo list:",
      JSON.stringify(todos, null, 2),
      "</system-reminder>",
    ].join("\n")
  }
}
