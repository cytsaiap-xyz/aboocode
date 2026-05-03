/**
 * check_messages — read this agent's mailbox.
 *
 * Two modes:
 *   - peek=true:    show ALL messages (read + unread) without modifying state
 *   - peek=false:   read only UNREAD messages and mark them read
 *
 * Default is peek=false (the consume-once mode), which is symmetric with
 * the auto-inject pre-turn helper. Use peek=true to inspect history.
 */

import z from "zod"
import { Tool } from "./tool"
import { Mailbox } from "@/team/mailbox"
import { TeamManager } from "@/team/manager"
import type { TeamMessage } from "@/team/messages"

function formatMessage(m: TeamMessage): string {
  const head = `[${new Date(m.ts).toISOString()}] from=${m.from} kind=${m.kind}${m.summary ? ` summary="${m.summary}"` : ""}`
  switch (m.kind) {
    case "text":
      return `${head}\n  ${m.text}`
    case "idle":
      return `${head}\n  status=${m.status}${m.result ? `\n  result: ${m.result}` : ""}`
    case "plan_approval_request":
      return `${head}\n  plan: ${m.plan.slice(0, 200)}${m.plan.length > 200 ? "…" : ""}${m.planPath ? `\n  planPath: ${m.planPath}` : ""}`
    case "plan_approval_response":
      return `${head}\n  approved=${m.approved}${m.feedback ? `\n  feedback: ${m.feedback}` : ""}${m.requestId ? `\n  requestId: ${m.requestId}` : ""}`
    case "shutdown_request":
      return `${head}\n  reason: ${m.reason}`
    case "shutdown_response":
      return `${head}\n  approved=${m.approved}${m.reason ? `\n  reason: ${m.reason}` : ""}`
  }
}

export const CheckMessagesTool = Tool.define("check_messages", {
  description: `Read messages from your mailbox.

Default behavior is to take all UNREAD messages and mark them read (so the next call returns empty until new messages arrive). Pass peek=true to inspect every message without modifying state.

Returns one block per message with sender, kind, timestamp, and body.`,
  parameters: z.object({
    peek: z.boolean().default(false).describe("If true, show all messages without marking unread → read"),
  }),
  async execute(params, ctx) {
    const teamId = await TeamManager.resolveTeamId(ctx.sessionID)
    if (!teamId) {
      return {
        title: "No team context",
        output: "Mailbox is unavailable outside an active team.",
        metadata: { count: 0, peek: params.peek, kinds: [] as string[] },
      }
    }
    const agentId = ctx.agent || "orchestrator"
    const messages = params.peek
      ? await Mailbox.read({ teamId, agentId })
      : await Mailbox.takeUnread({ teamId, agentId })
    if (messages.length === 0) {
      return {
        title: params.peek ? "Mailbox empty" : "No unread messages",
        output: params.peek ? "Mailbox has no messages." : "No new messages since the last check.",
        metadata: { count: 0, peek: params.peek, kinds: [] as string[] },
      }
    }
    return {
      title: `${messages.length} message${messages.length === 1 ? "" : "s"}${params.peek ? "" : " (now marked read)"}`,
      output: messages.map(formatMessage).join("\n\n"),
      metadata: { count: messages.length, peek: params.peek, kinds: messages.map((m) => m.kind) },
    }
  },
})
