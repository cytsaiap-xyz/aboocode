import { describe, expect, test, beforeEach } from "bun:test"
import { Mailbox } from "@/team/mailbox"
import type { TeamMessage } from "@/team/messages"

const TEST_TEAM = "test_team_mailbox"

function textMsg(from: string, to: string, text: string): TeamMessage {
  return { kind: "text", from, to, ts: Date.now(), read: false, text }
}

describe("Mailbox", () => {
  beforeEach(async () => {
    await Mailbox._resetForTests(TEST_TEAM)
  })

  test("send and read direct message", async () => {
    await Mailbox.send({ teamId: TEST_TEAM, message: textMsg("a", "b", "hello") })
    const inbox = await Mailbox.read({ teamId: TEST_TEAM, agentId: "b" })
    expect(inbox).toHaveLength(1)
    expect(inbox[0].kind).toBe("text")
    if (inbox[0].kind === "text") expect(inbox[0].text).toBe("hello")
    expect(inbox[0].from).toBe("a")
    expect(inbox[0].read).toBe(false)
  })

  test("takeUnread marks messages read and returns them once", async () => {
    await Mailbox.send({ teamId: TEST_TEAM, message: textMsg("a", "b", "1") })
    await Mailbox.send({ teamId: TEST_TEAM, message: textMsg("a", "b", "2") })
    const first = await Mailbox.takeUnread({ teamId: TEST_TEAM, agentId: "b" })
    expect(first).toHaveLength(2)
    const second = await Mailbox.takeUnread({ teamId: TEST_TEAM, agentId: "b" })
    expect(second).toHaveLength(0)
    const all = await Mailbox.read({ teamId: TEST_TEAM, agentId: "b" })
    expect(all).toHaveLength(2)
    expect(all.every((m) => m.read)).toBe(true)
  })

  test("broadcast to '*' fans out to every existing inbox", async () => {
    await Mailbox.ensureInbox(TEST_TEAM, "alpha")
    await Mailbox.ensureInbox(TEST_TEAM, "beta")
    await Mailbox.ensureInbox(TEST_TEAM, "orchestrator")
    const written = await Mailbox.send({
      teamId: TEST_TEAM,
      message: textMsg("orchestrator", "*", "all-hands"),
    })
    expect(written.sort()).toEqual(["alpha", "beta", "orchestrator"])
    const alpha = await Mailbox.read({ teamId: TEST_TEAM, agentId: "alpha" })
    const beta = await Mailbox.read({ teamId: TEST_TEAM, agentId: "beta" })
    expect(alpha).toHaveLength(1)
    expect(beta).toHaveLength(1)
  })

  test("clear empties the inbox", async () => {
    await Mailbox.send({ teamId: TEST_TEAM, message: textMsg("a", "b", "x") })
    await Mailbox.send({ teamId: TEST_TEAM, message: textMsg("a", "b", "y") })
    const removed = await Mailbox.clear({ teamId: TEST_TEAM, agentId: "b" })
    expect(removed).toBe(2)
    const after = await Mailbox.read({ teamId: TEST_TEAM, agentId: "b" })
    expect(after).toHaveLength(0)
  })

  test("structured message kinds round-trip", async () => {
    await Mailbox.send({
      teamId: TEST_TEAM,
      message: {
        kind: "idle",
        from: "worker",
        to: "orchestrator",
        ts: Date.now(),
        read: false,
        status: "resolved",
        result: "done",
      },
    })
    await Mailbox.send({
      teamId: TEST_TEAM,
      message: {
        kind: "plan_approval_request",
        from: "planner",
        to: "orchestrator",
        ts: Date.now(),
        read: false,
        plan: "step 1\nstep 2",
      },
    })
    const inbox = await Mailbox.read({ teamId: TEST_TEAM, agentId: "orchestrator" })
    expect(inbox).toHaveLength(2)
    const kinds = inbox.map((m) => m.kind).sort()
    expect(kinds).toEqual(["idle", "plan_approval_request"])
  })

  test("concurrent senders don't lose messages", async () => {
    const N = 30
    const senders = Array.from({ length: N }, (_, i) =>
      Mailbox.send({ teamId: TEST_TEAM, message: textMsg(`s${i}`, "b", `msg-${i}`) }),
    )
    await Promise.all(senders)
    const inbox = await Mailbox.read({ teamId: TEST_TEAM, agentId: "b" })
    expect(inbox).toHaveLength(N)
    const texts = new Set(
      inbox.filter((m) => m.kind === "text").map((m) => (m.kind === "text" ? m.text : "")),
    )
    expect(texts.size).toBe(N)
  })
})
