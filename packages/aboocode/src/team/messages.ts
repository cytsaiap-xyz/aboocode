/**
 * Team-message protocol.
 *
 * Mirrors Claude Code's mailbox message types but unified under a single
 * tagged-union envelope so callers can switch on `kind` without
 * reflecting on free-form payloads.
 *
 * Every message that lands in a teammate's inbox is one of these shapes.
 * The mailbox stores them as JSONL; readers parse with TeamMessage.parse
 * and route by `kind`.
 */

import { z } from "zod"

const Base = z.object({
  /** Sender's agent id (or "orchestrator" for the lead). */
  from: z.string(),
  /** Recipient's agent id, or "*" for broadcast. */
  to: z.string(),
  /** ms since epoch when the message was written. */
  ts: z.number(),
  /** Has the recipient marked it read? */
  read: z.boolean().default(false),
  /** Optional 5–10-word preview the UI can show without unwrapping the body. */
  summary: z.string().optional(),
})

export const TextMessage = Base.extend({
  kind: z.literal("text"),
  text: z.string(),
})

export const IdleNotification = Base.extend({
  kind: z.literal("idle"),
  /** "resolved" → done; "blocked" → needs help; "failed" → error. */
  status: z.enum(["resolved", "blocked", "failed"]),
  /** Result text (success summary or error message). */
  result: z.string().optional(),
})

export const PlanApprovalRequest = Base.extend({
  kind: z.literal("plan_approval_request"),
  plan: z.string(),
  /** Optional path to a plan file the recipient can open. */
  planPath: z.string().optional(),
})

export const PlanApprovalResponse = Base.extend({
  kind: z.literal("plan_approval_response"),
  approved: z.boolean(),
  /** Free-text feedback (always provided when not approved). */
  feedback: z.string().optional(),
  /** Echo the original request id so the requester can correlate. */
  requestId: z.string().optional(),
})

export const ShutdownRequest = Base.extend({
  kind: z.literal("shutdown_request"),
  reason: z.string(),
})

export const ShutdownResponse = Base.extend({
  kind: z.literal("shutdown_response"),
  approved: z.boolean(),
  reason: z.string().optional(),
})

export const TeamMessage = z.discriminatedUnion("kind", [
  TextMessage,
  IdleNotification,
  PlanApprovalRequest,
  PlanApprovalResponse,
  ShutdownRequest,
  ShutdownResponse,
])
export type TeamMessage = z.infer<typeof TeamMessage>

export type MessageKind = TeamMessage["kind"]

/** Recognized kinds — exported so the SendMessage tool can advertise them. */
export const MESSAGE_KINDS: MessageKind[] = [
  "text",
  "idle",
  "plan_approval_request",
  "plan_approval_response",
  "shutdown_request",
  "shutdown_response",
]
