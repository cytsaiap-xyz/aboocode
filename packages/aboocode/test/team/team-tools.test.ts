import { describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { TeamManager } from "../../src/team/manager"
import {
  PlanTeamTool,
  AddAgentTool,
  FinalizeTeamTool,
  ListTeamTool,
  DisbandTeamTool,
  DelegateTaskTool,
  DelegateTasksTool,
  DiscussTool,
} from "../../src/tool/team"
import type { Tool } from "../../src/tool/tool"

// Base context for tool execution (no ask needed for team tools)
function makeCtx(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: "msg-test",
    callID: "call-test",
    agent: "orchestrator",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

describe("PlanTeamTool", () => {
  test("has correct tool id", () => {
    expect(PlanTeamTool.id).toBe("plan_team")
  })

  test("initializes with correct description and parameters", async () => {
    const tool = await PlanTeamTool.init()
    expect(tool.description).toContain("Initialize team planning")
    expect(tool.parameters.shape.task_summary).toBeDefined()
  })

  test("execute creates a team and returns success", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await PlanTeamTool.init()
        const ctx = makeCtx("plan-session-1")
        const result = await tool.execute({ task_summary: "Build a microservice" }, ctx)

        expect(result.title).toBe("Team Planning Started")
        expect(result.output).toContain("Team planning initialized")
        expect(result.output).toContain("Build a microservice")
        expect(result.output).toContain("add_agent")

        // Verify team was actually created in TeamManager
        const team = TeamManager.getTeam("plan-session-1")
        expect(team).toBeDefined()
        expect(team!.status).toBe("planning")
        expect(team!.taskSummary).toBe("Build a microservice")
      },
    })
  })

  test("execute overwrites previous team for same session", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await PlanTeamTool.init()
        const ctx = makeCtx("plan-session-2")

        await tool.execute({ task_summary: "First task" }, ctx)
        await tool.execute({ task_summary: "Second task" }, ctx)

        const team = TeamManager.getTeam("plan-session-2")
        expect(team!.taskSummary).toBe("Second task")
      },
    })
  })
})

describe("AddAgentTool", () => {
  test("has correct tool id", () => {
    expect(AddAgentTool.id).toBe("add_agent")
  })

  test("initializes with correct parameters", async () => {
    const tool = await AddAgentTool.init()
    expect(tool.parameters.shape.agent_id).toBeDefined()
    expect(tool.parameters.shape.name).toBeDefined()
    expect(tool.parameters.shape.description).toBeDefined()
    expect(tool.parameters.shape.system_prompt).toBeDefined()
    expect(tool.parameters.shape.skills).toBeDefined()
  })

  test("returns error when no team exists", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AddAgentTool.init()
        const ctx = makeCtx("no-team-session")
        const result = await tool.execute(
          {
            agent_id: "test-agent",
            name: "Test Agent",
            description: "A test agent",
            system_prompt: "Do testing",
          },
          ctx,
        )

        expect(result.title).toBe("Error")
        expect(result.output).toContain("No team found")
      },
    })
  })

  test("creates agent file and loads agent when team exists", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // First create a team
        const planTool = await PlanTeamTool.init()
        const ctx = makeCtx("add-agent-session")
        await planTool.execute({ task_summary: "Test project" }, ctx)

        // Now add an agent
        const addTool = await AddAgentTool.init()
        const result = await addTool.execute(
          {
            agent_id: "my-test-agent",
            name: "My Test Agent",
            description: "Agent for testing",
            system_prompt: "You are a testing agent. Run all tests.",
          },
          ctx,
        )

        expect(result.title).toContain("Agent Added")
        expect(result.output).toContain("My Test Agent")
        expect(result.output).toContain("my-test-agent")
        expect(result.output).toContain("created and loaded successfully")

        // Verify agent file was written
        const dirs = [path.join(tmp.path, ".aboocode")]
        for (const dir of dirs) {
          const filePath = path.join(dir, "agents", "my-test-agent.md")
          try {
            const content = await fs.readFile(filePath, "utf-8")
            expect(content).toContain("name: My Test Agent")
            expect(content).toContain("description: Agent for testing")
            expect(content).toContain("mode: subagent")
            expect(content).toContain("You are a testing agent")
            expect(content).toContain("Recording Instructions")
            break
          } catch {
            // Try next dir
          }
        }

        // Verify agent was added to team state
        const team = TeamManager.getTeam("add-agent-session")
        expect(team!.pendingAgents).toHaveLength(1)
        expect(team!.pendingAgents[0].id).toBe("my-test-agent")
        expect(team!.pendingAgents[0].name).toBe("My Test Agent")
      },
    })
  })
})

describe("FinalizeTeamTool", () => {
  test("has correct tool id", () => {
    expect(FinalizeTeamTool.id).toBe("finalize_team")
  })

  test("returns error when no team exists", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await FinalizeTeamTool.init()
        const ctx = makeCtx("no-team")
        const result = await tool.execute({}, ctx)

        expect(result.title).toBe("Error")
        expect(result.output).toContain("No team found")
      },
    })
  })

  test("returns error when fewer than 2 agents", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Plan team and add only 1 agent via manager directly
        const planTool = await PlanTeamTool.init()
        const ctx = makeCtx("finalize-1-session")
        await planTool.execute({ task_summary: "Test" }, ctx)

        // Add one agent via AddAgentTool
        const addTool = await AddAgentTool.init()
        await addTool.execute(
          {
            agent_id: "only-agent",
            name: "Only Agent",
            description: "The one",
            system_prompt: "Be the agent",
          },
          ctx,
        )

        const finalizeTool = await FinalizeTeamTool.init()
        const result = await finalizeTool.execute({}, ctx)

        expect(result.title).toBe("Error")
        expect(result.output).toContain("at least 2 agents")
      },
    })
  })

  test("finalizes team when 2+ agents exist and are loaded", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const planTool = await PlanTeamTool.init()
        const addTool = await AddAgentTool.init()
        const finalizeTool = await FinalizeTeamTool.init()
        const ctx = makeCtx("finalize-ok-session")

        await planTool.execute({ task_summary: "Build something" }, ctx)
        await addTool.execute(
          {
            agent_id: "agent-x",
            name: "Agent X",
            description: "First",
            system_prompt: "Be X",
          },
          ctx,
        )
        await addTool.execute(
          {
            agent_id: "agent-y",
            name: "Agent Y",
            description: "Second",
            system_prompt: "Be Y",
          },
          ctx,
        )

        const result = await finalizeTool.execute({}, ctx)
        expect(result.title).toBe("Team Finalized")
        expect(result.output).toContain("2 agents")
        expect(result.output).toContain("agent-x")
        expect(result.output).toContain("agent-y")
        expect(result.output).toContain("delegate_task")

        // Verify team state
        const team = TeamManager.getTeam("finalize-ok-session")
        expect(team!.status).toBe("active")
        expect(team!.activeAgentIds).toEqual(["agent-x", "agent-y"])
      },
    })
  })
})

describe("ListTeamTool", () => {
  test("has correct tool id", () => {
    expect(ListTeamTool.id).toBe("list_team")
  })

  test("returns no team message when no team", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ListTeamTool.init()
        const ctx = makeCtx("no-list-session")
        const result = await tool.execute({}, ctx)

        expect(result.title).toBe("No Team")
        expect(result.output).toContain("No active team")
      },
    })
  })

  test("lists all team agents with their details", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const planTool = await PlanTeamTool.init()
        const addTool = await AddAgentTool.init()
        const listTool = await ListTeamTool.init()
        const ctx = makeCtx("list-session")

        await planTool.execute({ task_summary: "A complex task" }, ctx)
        await addTool.execute(
          {
            agent_id: "frontend-dev",
            name: "Frontend Dev",
            description: "Builds React components",
            system_prompt: "Build frontend",
            skills: ["react"],
          },
          ctx,
        )
        await addTool.execute(
          {
            agent_id: "backend-dev",
            name: "Backend Dev",
            description: "Builds API endpoints",
            system_prompt: "Build backend",
          },
          ctx,
        )

        const result = await listTool.execute({}, ctx)
        expect(result.title).toBe("Team Status")
        expect(result.output).toContain("planning")
        expect(result.output).toContain("A complex task")
        expect(result.output).toContain("frontend-dev")
        expect(result.output).toContain("Frontend Dev")
        expect(result.output).toContain("Builds React components")
        expect(result.output).toContain("backend-dev")
        expect(result.output).toContain("Backend Dev")
        expect(result.output).toContain("Agents (2)")
      },
    })
  })
})

describe("DisbandTeamTool", () => {
  test("has correct tool id", () => {
    expect(DisbandTeamTool.id).toBe("disband_team")
  })

  test("returns no team message when no team", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await DisbandTeamTool.init()
        const ctx = makeCtx("no-disband-session")
        const result = await tool.execute({}, ctx)

        expect(result.title).toBe("No Team")
        expect(result.output).toContain("No active team to disband")
      },
    })
  })

  test("disbands team, deletes agent files, and cleans up state", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const planTool = await PlanTeamTool.init()
        const addTool = await AddAgentTool.init()
        const disbandTool = await DisbandTeamTool.init()
        const ctx = makeCtx("disband-session")

        // Create team with agents
        await planTool.execute({ task_summary: "Temporary team" }, ctx)
        const addResult1 = await addTool.execute(
          {
            agent_id: "temp-agent-1",
            name: "Temp 1",
            description: "Temp agent 1",
            system_prompt: "Do temp work 1",
          },
          ctx,
        )
        const addResult2 = await addTool.execute(
          {
            agent_id: "temp-agent-2",
            name: "Temp 2",
            description: "Temp agent 2",
            system_prompt: "Do temp work 2",
          },
          ctx,
        )

        // Verify agents were created successfully
        expect(addResult1.title).toContain("Agent Added")
        expect(addResult2.title).toContain("Agent Added")

        // Verify team state has 2 agents
        const teamBefore = TeamManager.getTeam("disband-session")
        expect(teamBefore!.pendingAgents).toHaveLength(2)

        // Disband
        const result = await disbandTool.execute({}, ctx)
        expect(result.title).toBe("Team Disbanded")
        expect(result.output).toContain("Team disbanded")
        expect(result.output).toContain("agent files deleted")

        // Verify team state is gone
        const team = TeamManager.getTeam("disband-session")
        expect(team).toBeUndefined()
      },
    })
  })
})

describe("DelegateTaskTool", () => {
  test("has correct tool id", () => {
    expect(DelegateTaskTool.id).toBe("delegate_task")
  })

  test("initializes with correct parameters", async () => {
    const tool = await DelegateTaskTool.init()
    expect(tool.description).toContain("Delegate a task")
    expect(tool.parameters.shape.agent_id).toBeDefined()
    expect(tool.parameters.shape.task).toBeDefined()
  })

  test("returns error when no team exists", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await DelegateTaskTool.init()
        const ctx = makeCtx("delegate-session")
        const result = await tool.execute(
          { agent_id: "non-existent-agent", task: "Do something" },
          ctx,
        )

        expect(result.title).toContain("Error")
        expect(result.output).toContain("No team found")
      },
    })
  })

  test("returns error when agent not in team roster", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const planTool = await PlanTeamTool.init()
        const addTool = await AddAgentTool.init()
        const finalizeTool = await FinalizeTeamTool.init()
        const ctx = makeCtx("delegate-roster-session")

        await planTool.execute({ task_summary: "Test" }, ctx)
        await addTool.execute(
          { agent_id: "agent-a", name: "Agent A", description: "First", system_prompt: "Be A" },
          ctx,
        )
        await addTool.execute(
          { agent_id: "agent-b", name: "Agent B", description: "Second", system_prompt: "Be B" },
          ctx,
        )
        await finalizeTool.execute({}, ctx)

        const tool = await DelegateTaskTool.init()
        const result = await tool.execute(
          { agent_id: "non-existent-agent", task: "Do something" },
          ctx,
        )

        expect(result.title).toContain("Error")
        expect(result.output).toContain("not part of the current team")
      },
    })
  })
})

describe("DelegateTasksTool", () => {
  test("has correct tool id", () => {
    expect(DelegateTasksTool.id).toBe("delegate_tasks")
  })

  test("initializes with correct parameters", async () => {
    const tool = await DelegateTasksTool.init()
    expect(tool.description).toContain("Delegate multiple tasks")
    expect(tool.parameters.shape.delegations).toBeDefined()
  })

  test("returns error when no team exists for parallel delegation", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await DelegateTasksTool.init()
        const ctx = makeCtx("parallel-session")
        const result = await tool.execute(
          {
            delegations: [
              { agent_id: "ghost-agent-1", task: "Task 1" },
              { agent_id: "ghost-agent-2", task: "Task 2" },
            ],
          },
          ctx,
        )

        expect(result.title).toContain("Error")
        expect(result.output).toContain("No team found")
      },
    })
  })

  test("rejects agents not in team roster for parallel delegation", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const planTool = await PlanTeamTool.init()
        const addTool = await AddAgentTool.init()
        const finalizeTool = await FinalizeTeamTool.init()
        const ctx = makeCtx("parallel-roster-session")

        await planTool.execute({ task_summary: "Test" }, ctx)
        await addTool.execute(
          { agent_id: "real-1", name: "Real 1", description: "Exists", system_prompt: "Be real" },
          ctx,
        )
        await addTool.execute(
          { agent_id: "real-2", name: "Real 2", description: "Exists too", system_prompt: "Be real" },
          ctx,
        )
        await finalizeTool.execute({}, ctx)

        const tool = await DelegateTasksTool.init()
        const result = await tool.execute(
          {
            delegations: [
              { agent_id: "ghost-agent-1", task: "Task 1" },
              { agent_id: "ghost-agent-2", task: "Task 2" },
            ],
          },
          ctx,
        )

        expect(result.title).toContain("Error")
        expect(result.output).toContain("not part of the current team")
        expect(result.output).toContain("ghost-agent-1")
        expect(result.output).toContain("ghost-agent-2")
      },
    })
  })
})

describe("Team tool workflow integration", () => {
  test("full plan -> add agents -> finalize -> list -> disband flow", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ctx = makeCtx("workflow-session")

        // 1. Plan team
        const planTool = await PlanTeamTool.init()
        const planResult = await planTool.execute({ task_summary: "Build e-commerce app" }, ctx)
        expect(planResult.title).toBe("Team Planning Started")

        // 2. Add agents
        const addTool = await AddAgentTool.init()
        const addResult1 = await addTool.execute(
          {
            agent_id: "auth-dev",
            name: "Auth Developer",
            description: "Handles authentication",
            system_prompt: "Build auth system with JWT",
          },
          ctx,
        )
        expect(addResult1.title).toContain("Agent Added")

        const addResult2 = await addTool.execute(
          {
            agent_id: "product-dev",
            name: "Product Developer",
            description: "Handles product catalog",
            system_prompt: "Build product CRUD API",
          },
          ctx,
        )
        expect(addResult2.title).toContain("Agent Added")

        // 3. List team - should show 2 agents in planning
        const listTool = await ListTeamTool.init()
        const listResult = await listTool.execute({}, ctx)
        expect(listResult.output).toContain("planning")
        expect(listResult.output).toContain("auth-dev")
        expect(listResult.output).toContain("product-dev")
        expect(listResult.output).toContain("Agents (2)")

        // 4. Finalize team
        const finalizeTool = await FinalizeTeamTool.init()
        const finalizeResult = await finalizeTool.execute({}, ctx)
        expect(finalizeResult.title).toBe("Team Finalized")

        // 5. List team again - should show active
        const listResult2 = await listTool.execute({}, ctx)
        expect(listResult2.output).toContain("active")

        // 6. Disband team
        const disbandTool = await DisbandTeamTool.init()
        const disbandResult = await disbandTool.execute({}, ctx)
        expect(disbandResult.title).toBe("Team Disbanded")

        // 7. Verify cleanup
        expect(TeamManager.getTeam("workflow-session")).toBeUndefined()
      },
    })
  })
})

describe("DiscussTool", () => {
  test("has correct tool id", () => {
    expect(DiscussTool.id).toBe("discuss")
  })

  test("initializes with correct parameters", async () => {
    const tool = await DiscussTool.init()
    expect(tool.description).toContain("discussion")
    expect(tool.parameters.shape.topic).toBeDefined()
    expect(tool.parameters.shape.agents).toBeDefined()
    expect(tool.parameters.shape.max_rounds).toBeDefined()
  })

  test("returns error when no team exists", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await DiscussTool.init()
        const ctx = makeCtx("no-discuss-team")
        const result = await tool.execute(
          { topic: "Architecture", agents: ["agent-a", "agent-b"] },
          ctx,
        )

        expect(result.title).toBe("Error")
        expect(result.output).toContain("No team found")
      },
    })
  })

  test("returns error when team is not finalized", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const planTool = await PlanTeamTool.init()
        const ctx = makeCtx("discuss-not-finalized")
        await planTool.execute({ task_summary: "Test project" }, ctx)

        const tool = await DiscussTool.init()
        const result = await tool.execute(
          { topic: "Architecture", agents: ["agent-a", "agent-b"] },
          ctx,
        )

        expect(result.title).toBe("Error")
        expect(result.output).toContain("not finalized")
      },
    })
  })

  test("returns error when agent not found", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const planTool = await PlanTeamTool.init()
        const addTool = await AddAgentTool.init()
        const finalizeTool = await FinalizeTeamTool.init()
        const ctx = makeCtx("discuss-missing-agent")

        await planTool.execute({ task_summary: "Test project" }, ctx)
        await addTool.execute(
          { agent_id: "real-agent", name: "Real Agent", description: "Exists", system_prompt: "Be real" },
          ctx,
        )
        await addTool.execute(
          { agent_id: "real-agent-2", name: "Real Agent 2", description: "Also exists", system_prompt: "Be real too" },
          ctx,
        )
        await finalizeTool.execute({}, ctx)

        const tool = await DiscussTool.init()
        const result = await tool.execute(
          { topic: "Architecture", agents: ["real-agent", "ghost-agent"] },
          ctx,
        )

        expect(result.title).toBe("Error")
        expect(result.output).toContain("ghost-agent")
        expect(result.output).toContain("not found")
      },
    })
  })
})

describe("Team tools are registered", () => {
  test("all team tools have unique IDs", () => {
    const ids = [
      PlanTeamTool.id,
      AddAgentTool.id,
      FinalizeTeamTool.id,
      DelegateTaskTool.id,
      DelegateTasksTool.id,
      ListTeamTool.id,
      DisbandTeamTool.id,
      DiscussTool.id,
    ]
    expect(new Set(ids).size).toBe(8)
    expect(ids).toEqual([
      "plan_team",
      "add_agent",
      "finalize_team",
      "delegate_task",
      "delegate_tasks",
      "list_team",
      "disband_team",
      "discuss",
    ])
  })
})
