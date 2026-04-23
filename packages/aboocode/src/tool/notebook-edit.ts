/**
 * NotebookEdit tool — edit Jupyter notebook (.ipynb) cells.
 *
 * Ported from claude-code-leak/src/tools/NotebookEditTool. Supports three
 * edit modes: replace (default), insert, and delete. Preserves notebook
 * schema and metadata; only modifies the targeted cell.
 *
 * This closes one of the biggest tool gaps between aboocode and Claude Code
 * — notebook editing was previously unavailable.
 */

import path from "path"
import z from "zod"
import { Tool } from "./tool"
import { Filesystem } from "../util/filesystem"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { FileTime } from "../file/time"
import { IsolationPath } from "../agent/isolation-path"
import { assertExternalDirectory } from "./external-directory"
import DESCRIPTION from "./notebook-edit.txt"

type NotebookCell = {
  cell_type: "code" | "markdown" | "raw"
  source: string | string[]
  metadata?: Record<string, unknown>
  outputs?: unknown[]
  execution_count?: number | null
}

type Notebook = {
  cells: NotebookCell[]
  metadata?: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
}

function isNotebook(obj: unknown): obj is Notebook {
  if (!obj || typeof obj !== "object") return false
  const n = obj as Partial<Notebook>
  return Array.isArray(n.cells) && typeof n.nbformat === "number"
}

function normalizeSource(source: string): string[] {
  // Jupyter stores source as an array of lines with trailing newlines,
  // except for the last line which has no trailing newline.
  if (source.length === 0) return [""]
  const lines = source.split("\n")
  return lines.map((line, i) => (i === lines.length - 1 ? line : line + "\n"))
}

function cellToSourceString(cell: NotebookCell): string {
  if (typeof cell.source === "string") return cell.source
  return cell.source.join("")
}

export const NotebookEditTool = Tool.define("notebook_edit", {
  description: DESCRIPTION,
  parameters: z.object({
    notebook_path: z.string().describe("The absolute path to the .ipynb file to edit"),
    cell_number: z.number().int().nonnegative().describe("0-indexed cell number to edit"),
    new_source: z.string().optional().describe("New source for the cell (omit when edit_mode=delete)"),
    cell_type: z.enum(["code", "markdown"]).optional().describe("Cell type (required when edit_mode=insert)"),
    edit_mode: z.enum(["replace", "insert", "delete"]).default("replace"),
  }),
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.notebook_path)
      ? params.notebook_path
      : IsolationPath.resolve(ctx.sessionID, params.notebook_path)
    await assertExternalDirectory(ctx, filepath)

    if (!filepath.endsWith(".ipynb")) {
      throw new Error(`notebook_edit can only edit .ipynb files (got: ${path.basename(filepath)})`)
    }

    const raw = await Filesystem.readText(filepath)
    await FileTime.assert(ctx.sessionID, filepath)

    let notebook: Notebook
    try {
      const parsed = JSON.parse(raw)
      if (!isNotebook(parsed)) throw new Error("not a valid Jupyter notebook")
      notebook = parsed
    } catch (e) {
      throw new Error(`Failed to parse notebook ${filepath}: ${e instanceof Error ? e.message : String(e)}`)
    }

    const cellCount = notebook.cells.length

    if (params.edit_mode === "delete") {
      if (params.cell_number >= cellCount) {
        throw new Error(`cell_number ${params.cell_number} out of range (notebook has ${cellCount} cells)`)
      }
      notebook.cells.splice(params.cell_number, 1)
    } else if (params.edit_mode === "insert") {
      if (!params.new_source) {
        throw new Error("edit_mode=insert requires new_source")
      }
      if (!params.cell_type) {
        throw new Error("edit_mode=insert requires cell_type")
      }
      if (params.cell_number > cellCount) {
        throw new Error(`cell_number ${params.cell_number} out of range for insert (notebook has ${cellCount} cells)`)
      }
      const newCell: NotebookCell = {
        cell_type: params.cell_type,
        source: normalizeSource(params.new_source),
        metadata: {},
      }
      if (params.cell_type === "code") {
        newCell.outputs = []
        newCell.execution_count = null
      }
      notebook.cells.splice(params.cell_number, 0, newCell)
    } else {
      // replace
      if (params.new_source === undefined) {
        throw new Error("edit_mode=replace requires new_source")
      }
      if (params.cell_number >= cellCount) {
        throw new Error(`cell_number ${params.cell_number} out of range (notebook has ${cellCount} cells)`)
      }
      const existing = notebook.cells[params.cell_number]
      const targetType = params.cell_type ?? (existing.cell_type === "raw" ? "code" : existing.cell_type)
      existing.cell_type = targetType as NotebookCell["cell_type"]
      existing.source = normalizeSource(params.new_source)
      if (targetType === "code") {
        // Clear outputs and execution count on edit to avoid stale results.
        existing.outputs = []
        existing.execution_count = null
      } else {
        delete existing.outputs
        delete existing.execution_count
      }
    }

    // Ask for permission on the write — reuse the edit permission path so
    // existing rulesets apply.
    await ctx.ask({
      permission: "edit",
      patterns: [IsolationPath.relative(ctx.sessionID, filepath)],
      always: ["*"],
      metadata: {
        filepath,
        edit_mode: params.edit_mode,
        cell_number: params.cell_number,
      },
    })

    const serialized = JSON.stringify(notebook, null, 1) + "\n"
    await Filesystem.write(filepath, serialized)
    await Bus.publish(File.Event.Edited, { file: filepath })
    await Bus.publish(FileWatcher.Event.Updated, { file: filepath, event: "change" })
    FileTime.read(ctx.sessionID, filepath)

    const action =
      params.edit_mode === "delete"
        ? `Deleted cell ${params.cell_number}`
        : params.edit_mode === "insert"
          ? `Inserted ${params.cell_type} cell at index ${params.cell_number}`
          : `Replaced cell ${params.cell_number}`

    return {
      title: IsolationPath.relative(ctx.sessionID, filepath),
      metadata: {
        filepath,
        edit_mode: params.edit_mode,
        cell_number: params.cell_number,
        cell_count: notebook.cells.length,
      },
      output: `${action} in ${path.basename(filepath)}\nNotebook now has ${notebook.cells.length} cells.\n\nCell source preview:\n${params.new_source ? params.new_source.split("\n").slice(0, 20).join("\n") : "(deleted)"}`,
    }
  },
})
