/**
 * Cron-event consumer — turns CronRunner.Event.Fired into prompts.
 *
 * The cron runner publishes `cron.fire` whenever a scheduled job is due.
 * This module subscribes to that event and surfaces the job's prompt to
 * the target session as a synthetic user message.
 *
 * Routing rules:
 *   1. Job has `sessionID` set → deliver to that session.
 *      - If the session is part of a team, drop a `text` mailbox message
 *        addressed to that session's agent; the existing auto-inject in
 *        the session loop will surface it on the next turn.
 *      - Otherwise, kick `SessionPrompt.prompt()` async (fire-and-forget)
 *        so the model wakes up and processes the cron prompt.
 *   2. Job has no `sessionID` (cron created without a session context)
 *      → log only. We don't auto-create sessions — too aggressive.
 *
 * The consumer is process-global and idempotent. It boots once via
 * `CronConsumer.start()`, called from session boot alongside the runner.
 */

import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { CronRunner } from "./cron-runner"

const log = Log.create({ service: "scheduler.cron-consumer" })

let started = false
let unsubscribe: (() => void) | null = null

export namespace CronConsumer {
  /**
   * Subscribe to cron.fire. Idempotent — a second start is a no-op.
   */
  export function start(): void {
    if (started) return
    started = true
    unsubscribe = Bus.subscribe(CronRunner.Event.Fired, async (event) => {
      const { id, sessionID, prompt, firedAt } = event.properties
      if (!sessionID) {
        log.warn("cron fired without sessionID — dropping (no session to wake)", { id })
        return
      }
      try {
        await deliver({ jobId: id, sessionID, prompt, firedAt })
      } catch (e) {
        log.error("cron delivery failed", { id, sessionID, error: e })
      }
    })
    log.info("cron consumer subscribed")
  }

  export function stop(): void {
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
    started = false
  }

  async function deliver(input: {
    jobId: string
    sessionID: string
    prompt: string
    firedAt: number
  }): Promise<void> {
    // Try the team mailbox path first. If the session is part of a team,
    // dropping a text message is non-disruptive: the next turn will
    // auto-inject it as a system-reminder. No fresh prompt is started.
    try {
      const { TeamManager } = await import("@/team/manager")
      const teamId = await TeamManager.resolveTeamId(input.sessionID)
      if (teamId) {
        const { Mailbox } = await import("@/team/mailbox")
        // Look up the agent name from the session's most recent user
        // message so the message lands in the right inbox. Fallback:
        // orchestrator (the team lead).
        let agentId = "orchestrator"
        try {
          const { MessageV2 } = await import("@/session/message-v2")
          for await (const item of MessageV2.stream(input.sessionID)) {
            if (item.info.role === "user" && item.info.agent) {
              agentId = item.info.agent
              break
            }
          }
        } catch {
          /* ignore — fallback to orchestrator */
        }
        await Mailbox.send({
          teamId,
          message: {
            kind: "text",
            from: "cron",
            to: agentId,
            ts: input.firedAt,
            read: false,
            text: input.prompt,
            summary: `cron job ${input.jobId} fired`,
          },
        })
        log.info("cron delivered via mailbox", { jobId: input.jobId, sessionID: input.sessionID, agentId })
        return
      }
    } catch (e) {
      log.warn("team-mailbox delivery failed; falling back to direct prompt", { error: e })
    }

    // Fallback: kick a fresh prompt on the target session. This is async
    // and fire-and-forget — if the session is currently active, the new
    // turn will queue behind the in-flight one (SessionPrompt handles
    // concurrent prompts via its callback queue).
    try {
      const { SessionPrompt } = await import("@/session/prompt")
      void SessionPrompt.prompt({
        sessionID: input.sessionID,
        parts: [
          {
            type: "text",
            text: `<system-reminder>\nScheduled cron job ${input.jobId} fired at ${new Date(input.firedAt).toISOString()}.\n</system-reminder>\n\n${input.prompt}`,
          },
        ],
      }).catch((e) => {
        log.error("direct cron prompt failed", { jobId: input.jobId, sessionID: input.sessionID, error: e })
      })
      log.info("cron delivered via direct prompt", { jobId: input.jobId, sessionID: input.sessionID })
    } catch (e) {
      log.error("cron delivery: both paths failed", { jobId: input.jobId, sessionID: input.sessionID, error: e })
    }
  }
}
