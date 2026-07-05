import z from "zod"
import path from "path"
import { mkdir, writeFile } from "fs/promises"
import { randomBytes } from "crypto"
import { Tool } from "../tool/tool"
import { Global } from "../global"
import { WorkflowRuntime } from "./runtime"
import { WorkflowRun } from "./run"
import { BackgroundTasks } from "../session/background"
import DESCRIPTION from "./tool.txt"

export namespace WorkflowResultFormat {
  export function summarize(r: { runId: string; status: string; value?: any; error?: string }): string {
    let out = `workflow ${r.runId} ${r.status}`
    if (r.error) out += `: ${r.error}`
    if (r.value !== undefined) {
      try {
        out += `\n<result>\n${JSON.stringify(r.value, null, 2).slice(0, 4000)}\n</result>`
      } catch {
        out += `\n<result>[unserializable]</result>`
      }
    }
    return out
  }
}

export const WorkflowTool = Tool.define("workflow", {
  description: DESCRIPTION,
  parameters: z.object({
    script: z.string().optional().describe("Inline workflow script beginning with `export const meta = {…}`"),
    scriptPath: z.string().optional().describe("Path to a workflow script file (takes precedence over script)"),
    args: z.any().optional().describe("JSON value exposed to the script as the global `args`"),
    resumeFromRunId: z.string().optional().describe("Resume a prior run in this session"),
  }),
  async execute(params, ctx) {
    const source = params.scriptPath ? await Bun.file(params.scriptPath).text() : params.script
    if (!source) throw new Error("workflow requires either `script` or `scriptPath`")

    const meta = WorkflowRuntime.parseMeta(source)

    await ctx.ask({
      permission: "workflow",
      patterns: [meta.name],
      always: ["*"],
      metadata: { name: meta.name, phases: (meta.phases ?? []).map((p) => p.title) },
    })

    let scriptPath: string
    if (params.resumeFromRunId) {
      scriptPath = params.scriptPath ?? "(resumed)"
    } else {
      const dir = path.join(Global.Path.data, "workflows", ctx.sessionID)
      await mkdir(dir, { recursive: true })
      scriptPath =
        params.scriptPath ?? path.join(dir, `wf_${Date.now().toString(36)}${randomBytes(5).toString("hex")}.js`)
      if (!params.scriptPath) await writeFile(scriptPath, source, "utf-8")
    }

    const { runId, done } = await WorkflowRun.start({
      sessionID: ctx.sessionID,
      source,
      scriptPath,
      args: params.args,
      resumeFromRunId: params.resumeFromRunId,
      abort: ctx.abort,
    }, meta)

    BackgroundTasks.register({
      taskID: runId,
      sessionID: ctx.sessionID,
      parentSessionID: ctx.sessionID,
      description: `workflow: ${meta.name}`,
      agentType: "workflow",
      promise: done.then((r) => WorkflowResultFormat.summarize(r)),
    })

    return {
      title: `Workflow ${meta.name} started`,
      output: [
        `Started workflow "${meta.name}" (run ${runId}).`,
        `script: ${scriptPath}`,
        `Progress streams via workflow.* events; the result returns when it finishes.`,
      ].join("\n"),
      metadata: { runId, scriptPath, name: meta.name },
    }
  },
})
