import { describe, test, expect, beforeEach } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { TeamManager } from "../../src/team/manager"

describe("TeamManager", () => {
  test("startTeam creates a team in planning status", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        const team = TeamManager.startTeam("session-1", "Build a REST API")
        expect(team).toBeDefined()
        expect(team.taskSummary).toBe("Build a REST API")
        expect(team.status).toBe("planning")
        expect(team.pendingAgents).toEqual([])
        expect(team.activeAgentIds).toEqual([])
      },
    })
  })

  test("getTeam returns undefined for non-existent session", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        const team = TeamManager.getTeam("non-existent")
        expect(team).toBeUndefined()
      },
    })
  })

  test("getTeam returns team after startTeam", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        TeamManager.startTeam("session-2", "Test task")
        const team = TeamManager.getTeam("session-2")
        expect(team).toBeDefined()
        expect(team!.taskSummary).toBe("Test task")
      },
    })
  })

  test("addAgent adds agent to pending list", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        TeamManager.startTeam("session-3", "Test task")
        TeamManager.addAgent("session-3", {
          id: "agent-a",
          name: "Agent A",
          description: "First agent",
          skills: ["skill1"],
        })
        const team = TeamManager.getTeam("session-3")
        expect(team!.pendingAgents).toHaveLength(1)
        expect(team!.pendingAgents[0].id).toBe("agent-a")
        expect(team!.pendingAgents[0].name).toBe("Agent A")
        expect(team!.pendingAgents[0].skills).toEqual(["skill1"])
      },
    })
  })

  test("addAgent throws when no team exists", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(() =>
          TeamManager.addAgent("no-session", {
            id: "agent-a",
            name: "Agent A",
            description: "First agent",
            skills: [],
          }),
        ).toThrow("No team found")
      },
    })
  })

  test("addAgent throws on duplicate agent id", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        TeamManager.startTeam("session-4", "Test task")
        TeamManager.addAgent("session-4", {
          id: "agent-a",
          name: "Agent A",
          description: "First agent",
          skills: [],
        })
        expect(() =>
          TeamManager.addAgent("session-4", {
            id: "agent-a",
            name: "Agent A Copy",
            description: "Duplicate",
            skills: [],
          }),
        ).toThrow('Agent with id "agent-a" already exists')
      },
    })
  })

  test("addAgent throws when team is already finalized", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        TeamManager.startTeam("session-5", "Test task")
        TeamManager.addAgent("session-5", {
          id: "agent-a",
          name: "Agent A",
          description: "First",
          skills: [],
        })
        TeamManager.addAgent("session-5", {
          id: "agent-b",
          name: "Agent B",
          description: "Second",
          skills: [],
        })
        TeamManager.finalizeTeam("session-5")
        expect(() =>
          TeamManager.addAgent("session-5", {
            id: "agent-c",
            name: "Agent C",
            description: "Third",
            skills: [],
          }),
        ).toThrow("Team is already finalized")
      },
    })
  })

  test("finalizeTeam transitions to active with agent IDs", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        TeamManager.startTeam("session-6", "Test task")
        TeamManager.addAgent("session-6", {
          id: "agent-a",
          name: "Agent A",
          description: "First",
          skills: [],
        })
        TeamManager.addAgent("session-6", {
          id: "agent-b",
          name: "Agent B",
          description: "Second",
          skills: [],
        })
        const ids = TeamManager.finalizeTeam("session-6")
        expect(ids).toEqual(["agent-a", "agent-b"])

        const team = TeamManager.getTeam("session-6")
        expect(team!.status).toBe("active")
        expect(team!.activeAgentIds).toEqual(["agent-a", "agent-b"])
      },
    })
  })

  test("finalizeTeam throws when no team exists", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(() => TeamManager.finalizeTeam("no-session")).toThrow("No team found")
      },
    })
  })

  test("finalizeTeam throws with fewer than 2 agents", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        TeamManager.startTeam("session-7", "Test task")
        TeamManager.addAgent("session-7", {
          id: "agent-a",
          name: "Agent A",
          description: "Only one",
          skills: [],
        })
        expect(() => TeamManager.finalizeTeam("session-7")).toThrow("at least 2 agents")
      },
    })
  })

  test("finalizeTeam throws when already finalized", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        TeamManager.startTeam("session-8", "Test task")
        TeamManager.addAgent("session-8", {
          id: "agent-a",
          name: "Agent A",
          description: "First",
          skills: [],
        })
        TeamManager.addAgent("session-8", {
          id: "agent-b",
          name: "Agent B",
          description: "Second",
          skills: [],
        })
        TeamManager.finalizeTeam("session-8")
        expect(() => TeamManager.finalizeTeam("session-8")).toThrow("already finalized")
      },
    })
  })

  test("listTeam returns empty array for non-existent session", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        const agents = TeamManager.listTeam("no-session")
        expect(agents).toEqual([])
      },
    })
  })

  test("listTeam returns all pending agents", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        TeamManager.startTeam("session-9", "Test task")
        TeamManager.addAgent("session-9", {
          id: "agent-a",
          name: "Agent A",
          description: "First",
          skills: ["s1"],
        })
        TeamManager.addAgent("session-9", {
          id: "agent-b",
          name: "Agent B",
          description: "Second",
          skills: [],
        })
        const agents = TeamManager.listTeam("session-9")
        expect(agents).toHaveLength(2)
        expect(agents[0].id).toBe("agent-a")
        expect(agents[1].id).toBe("agent-b")
      },
    })
  })

  test("disbandTeam removes team state", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        TeamManager.startTeam("session-10", "Test task")
        TeamManager.addAgent("session-10", {
          id: "agent-a",
          name: "Agent A",
          description: "First",
          skills: [],
        })
        TeamManager.disbandTeam("session-10")
        const team = TeamManager.getTeam("session-10")
        expect(team).toBeUndefined()
      },
    })
  })

  test("disbandTeam is safe for non-existent session", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        // Should not throw
        TeamManager.disbandTeam("non-existent-session")
        expect(TeamManager.getTeam("non-existent-session")).toBeUndefined()
      },
    })
  })

  test("multiple teams can coexist for different sessions", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        TeamManager.startTeam("session-a", "Task A")
        TeamManager.startTeam("session-b", "Task B")

        TeamManager.addAgent("session-a", {
          id: "agent-1",
          name: "Agent 1",
          description: "For A",
          skills: [],
        })
        TeamManager.addAgent("session-b", {
          id: "agent-2",
          name: "Agent 2",
          description: "For B",
          skills: [],
        })

        const teamA = TeamManager.getTeam("session-a")
        const teamB = TeamManager.getTeam("session-b")

        expect(teamA!.taskSummary).toBe("Task A")
        expect(teamA!.pendingAgents).toHaveLength(1)
        expect(teamA!.pendingAgents[0].id).toBe("agent-1")

        expect(teamB!.taskSummary).toBe("Task B")
        expect(teamB!.pendingAgents).toHaveLength(1)
        expect(teamB!.pendingAgents[0].id).toBe("agent-2")
      },
    })
  })

  test("startTeam overwrites existing team for same session", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        TeamManager.startTeam("session-c", "Original task")
        TeamManager.addAgent("session-c", {
          id: "old-agent",
          name: "Old Agent",
          description: "Should be gone",
          skills: [],
        })

        // Re-start overwrites
        TeamManager.startTeam("session-c", "New task")
        const team = TeamManager.getTeam("session-c")
        expect(team!.taskSummary).toBe("New task")
        expect(team!.pendingAgents).toHaveLength(0)
      },
    })
  })
})
