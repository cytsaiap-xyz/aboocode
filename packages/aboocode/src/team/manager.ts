import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { UsageLog } from "../usage-log"
import { DebugLog } from "../debug-log"
import { Mailbox } from "./mailbox"

export namespace TeamManager {
  const log = Log.create({ service: "team.manager" })

  export type TeamStatus = "planning" | "active" | "disbanded"

  export interface TeamAgent {
    id: string
    name: string
    description: string
    skills: string[]
  }

  export interface TeamState {
    taskSummary: string
    status: TeamStatus
    pendingAgents: TeamAgent[]
    activeAgentIds: string[]
  }

  const state = Instance.state(() => {
    const teams: Record<string, TeamState> = {}
    return teams
  })

  function teamKey(sessionID: string): string {
    return sessionID
  }

  export function startTeam(sessionID: string, taskSummary: string): TeamState {
    UsageLog.record("team.manager", "startTeam", { sessionID, taskSummary })
    const key = teamKey(sessionID)
    const team: TeamState = {
      taskSummary,
      status: "planning",
      pendingAgents: [],
      activeAgentIds: [],
    }
    state()[key] = team
    DebugLog.teamPlanStarted(sessionID, taskSummary)
    log.info("team started", { sessionID, taskSummary })
    return team
  }

  export function getTeam(sessionID: string): TeamState | undefined {
    return state()[teamKey(sessionID)]
  }

  export function addAgent(sessionID: string, agent: TeamAgent): void {
    UsageLog.record("team.manager", "addAgent", { sessionID, agentId: agent.id })
    const team = state()[teamKey(sessionID)]
    if (!team) throw new Error("No team found. Call plan_team first.")
    if (team.status !== "planning") throw new Error("Team is already finalized. Cannot add more agents.")

    // Check for duplicate
    if (team.pendingAgents.some((a) => a.id === agent.id)) {
      throw new Error(`Agent with id "${agent.id}" already exists in the team.`)
    }

    team.pendingAgents.push(agent)
    DebugLog.teamAgentAdded(sessionID, agent.id, agent.name, agent.description)
    log.info("agent added to team", { sessionID, agentId: agent.id })
  }

  export function finalizeTeam(sessionID: string): string[] {
    UsageLog.record("team.manager", "finalizeTeam", { sessionID, agentCount: state()[teamKey(sessionID)]?.pendingAgents.length })
    const team = state()[teamKey(sessionID)]
    if (!team) throw new Error("No team found. Call plan_team first.")
    if (team.status !== "planning") throw new Error("Team is already finalized.")
    if (team.pendingAgents.length < 2) throw new Error("Team must have at least 2 agents. Add more agents first.")

    team.activeAgentIds = team.pendingAgents.map((a) => a.id)
    team.status = "active"
    DebugLog.teamFinalized(sessionID, team.activeAgentIds)
    log.info("team finalized", { sessionID, agents: team.activeAgentIds })

    // Phase 13.5: ensure every teammate has an inbox file plus the
    // orchestrator itself, so broadcast (`to:"*"`) reaches all members
    // and idle notifications have somewhere to land.
    const teamId = teamKey(sessionID)
    const recipients = ["orchestrator", ...team.activeAgentIds]
    void Promise.all(recipients.map((id) => Mailbox.ensureInbox(teamId, id))).catch((e) => {
      log.warn("ensureInbox on finalize failed", { error: e })
    })
    return team.activeAgentIds
  }

  export function listTeam(sessionID: string): TeamAgent[] {
    UsageLog.record("team.manager", "listTeam", { sessionID })
    const team = state()[teamKey(sessionID)]
    if (!team) return []
    DebugLog.teamListTeam(sessionID, team.pendingAgents)
    return team.pendingAgents
  }

  export function disbandTeam(sessionID: string): void {
    UsageLog.record("team.manager", "disbandTeam", { sessionID })
    const key = teamKey(sessionID)
    const team = state()[key]
    if (team) {
      team.status = "disbanded"
      DebugLog.teamDisbanded(sessionID, [])
      log.info("team disbanded", { sessionID })
    }
    delete state()[key]
  }

  /**
   * Resolve the team id used by the mailbox layer. Currently a 1:1 alias
   * for the orchestrator session id, but kept as a separate function so
   * the team-id derivation can change without rippling through callers.
   */
  export function teamIdFor(sessionID: string): string {
    return teamKey(sessionID)
  }

  /**
   * Walk up the parent-session chain until we find a session that owns
   * a team. That session id is the team id. Returns undefined if no
   * ancestor is part of a team — caller should treat that as "messaging
   * is unavailable in this context."
   */
  export async function resolveTeamId(sessionID: string): Promise<string | undefined> {
    const { Session } = await import("../session")
    let current: string | undefined = sessionID
    const seen = new Set<string>()
    while (current && !seen.has(current)) {
      seen.add(current)
      if (state()[teamKey(current)]) return teamKey(current)
      try {
        const info: { parentID?: string } = await Session.get(current)
        current = info.parentID
      } catch {
        return undefined
      }
    }
    return undefined
  }
}
