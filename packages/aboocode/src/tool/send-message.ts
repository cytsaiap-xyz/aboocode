/**
 * send_message — drop a message into a teammate's inbox.
 *
 * Mirrors Claude Code's SendMessageTool. Inputs:
 *   - to:     recipient agent id, or "*" to broadcast to all teammates
 *             (excluding self)
 *   - kind:   one of the structured message kinds; default "text"
 *   - text:   body for text messages
 *   - status / result          (idle)
 *   - plan / planPath          (plan_approval_request)
 *   - approved / feedback      (plan_approval_response)
 *   - reason                   (shutdown_request, shutdown_response)
 *   - summary: optional 5–10-word preview shown by the UI
 *
 * Fire-and-forget: writes the JSONL line and returns. The recipient
 * sees the message at the start of its next turn (auto-injected) or
 * via check_messages.
 */

import z from "zod"
import { Tool } from "./tool"
import { Mailbox } from "@/team/mailbox"
import { TeamManager } from "@/team/manager"
import type { TeamMessage } from "@/team/messages"
import { MESSAGE_KINDS } from "@/team/messages"

export const SendMessageTool = Tool.define("send_message", {
  description: `Send a message to one teammate or broadcast to all teammates.

Recipients are identified by their agent id (e.g., "explore_agent"). Use "*" to broadcast to every teammate (excluding yourself).

Message kinds:
  - text                       free-form text body (default)
  - idle                       you have nothing to do; carries status (resolved | blocked | failed) and an optional result
  - plan_approval_request      ask a teammate to approve a plan
  - plan_approval_response     respond to a plan approval request
  - shutdown_request           ask a teammate to wind down
  - shutdown_response          accept or reject the shutdown request

Provide a short \`summary\` (5–10 words) so the recipient's inbox UI can show a preview without unwrapping the body. Send is fire-and-forget — the recipient acts on the message at the start of its next turn.`,
  parameters: z.object({
    to: z.string().describe('Recipient agent id, or "*" to broadcast'),
    kind: z.enum(MESSAGE_KINDS as [string, ...string[]]).default("text"),
    summary: z.string().max(120).optional(),
    text: z.string().optional().describe("Body for kind=text"),
    status: z.enum(["resolved", "blocked", "failed"]).optional().describe("For kind=idle"),
    result: z.string().optional().describe("For kind=idle — success summary or error message"),
    plan: z.string().optional().describe("For kind=plan_approval_request"),
    planPath: z.string().optional().describe("For kind=plan_approval_request"),
    approved: z.boolean().optional().describe("For kind=plan_approval_response or shutdown_response"),
    feedback: z.string().optional().describe("For kind=plan_approval_response"),
    reason: z.string().optional().describe("For kind=shutdown_request | shutdown_response"),
    requestId: z.string().optional().describe("Echo of the original request id (plan_approval_response)"),
  }),
  async execute(params, ctx) {
    const teamId = await TeamManager.resolveTeamId(ctx.sessionID)
    if (!teamId) {
      return {
        title: "No team context",
        output:
          "send_message requires an active team. Call plan_team / finalize_team first, or run from inside a delegated session.",
        metadata: { delivered: [] as string[], kind: params.kind, broadcast: params.to === "*", skipped: true },
      }
    }

    await ctx.ask({
      permission: "send_message",
      patterns: [params.to, params.kind],
      always: ["*"],
      metadata: { to: params.to, kind: params.kind },
    })

    const from = ctx.agent || "orchestrator"
    const base = { from, to: params.to, ts: Date.now(), read: false, summary: params.summary }
    let envelope: TeamMessage
    switch (params.kind) {
      case "text":
        if (!params.text) throw new Error("kind=text requires `text`")
        envelope = { ...base, kind: "text", text: params.text }
        break
      case "idle":
        if (!params.status) throw new Error("kind=idle requires `status`")
        envelope = { ...base, kind: "idle", status: params.status, result: params.result }
        break
      case "plan_approval_request":
        if (!params.plan) throw new Error("kind=plan_approval_request requires `plan`")
        envelope = { ...base, kind: "plan_approval_request", plan: params.plan, planPath: params.planPath }
        break
      case "plan_approval_response":
        if (params.approved === undefined) throw new Error("kind=plan_approval_response requires `approved`")
        envelope = {
          ...base,
          kind: "plan_approval_response",
          approved: params.approved,
          feedback: params.feedback,
          requestId: params.requestId,
        }
        break
      case "shutdown_request":
        if (!params.reason) throw new Error("kind=shutdown_request requires `reason`")
        envelope = { ...base, kind: "shutdown_request", reason: params.reason }
        break
      case "shutdown_response":
        if (params.approved === undefined) throw new Error("kind=shutdown_response requires `approved`")
        envelope = { ...base, kind: "shutdown_response", approved: params.approved, reason: params.reason }
        break
      default:
        throw new Error(`Unknown message kind: ${params.kind}`)
    }

    let delivered = await Mailbox.send({ teamId, message: envelope })
    // Don't deliver to self on broadcast.
    if (params.to === "*") {
      delivered = delivered.filter((id) => id !== from)
    }
    return {
      title: params.to === "*" ? `Broadcast (${delivered.length})` : `Sent → ${params.to}`,
      output:
        delivered.length === 0
          ? `No recipients received the message (broadcast may have hit no inboxes other than the sender).`
          : `Delivered to: ${delivered.join(", ")}`,
      metadata: { delivered, kind: params.kind, broadcast: params.to === "*", skipped: false },
    }
  },
})
