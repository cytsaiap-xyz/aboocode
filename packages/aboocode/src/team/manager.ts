import { Instance } from "../project/instance"
import { Log } from "../util/log"

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
    const key = teamKey(sessionID)
    const team: TeamState = {
      taskSummary,
      status: "planning",
      pendingAgents: [],
      activeAgentIds: [],
    }
    state()[key] = team
    log.info("team started", { sessionID, taskSummary })
    return team
  }

  export function getTeam(sessionID: string): TeamState | undefined {
    return state()[teamKey(sessionID)]
  }

  export function addAgent(sessionID: string, agent: TeamAgent): void {
    const team = state()[teamKey(sessionID)]
    if (!team) throw new Error("No team found. Call plan_team first.")
    if (team.status !== "planning") throw new Error("Team is already finalized. Cannot add more agents.")

    // Check for duplicate
    if (team.pendingAgents.some((a) => a.id === agent.id)) {
      throw new Error(`Agent with id "${agent.id}" already exists in the team.`)
    }

    team.pendingAgents.push(agent)
    log.info("agent added to team", { sessionID, agentId: agent.id })
  }

  export function finalizeTeam(sessionID: string): string[] {
    const team = state()[teamKey(sessionID)]
    if (!team) throw new Error("No team found. Call plan_team first.")
    if (team.status !== "planning") throw new Error("Team is already finalized.")
    if (team.pendingAgents.length < 2) throw new Error("Team must have at least 2 agents. Add more agents first.")

    team.activeAgentIds = team.pendingAgents.map((a) => a.id)
    team.status = "active"
    log.info("team finalized", { sessionID, agents: team.activeAgentIds })
    return team.activeAgentIds
  }

  export function listTeam(sessionID: string): TeamAgent[] {
    const team = state()[teamKey(sessionID)]
    if (!team) return []
    return team.pendingAgents
  }

  export function disbandTeam(sessionID: string): void {
    const key = teamKey(sessionID)
    const team = state()[key]
    if (team) {
      team.status = "disbanded"
      log.info("team disbanded", { sessionID })
    }
    delete state()[key]
  }
}
