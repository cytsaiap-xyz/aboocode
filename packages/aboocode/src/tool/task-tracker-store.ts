/**
 * Session-scoped task tracker store.
 *
 * Phase 13: backs the TaskCreate / TaskGet / TaskList / TaskStop /
 * TaskOutput / TaskUpdate tools. Lightweight (in-memory, session-scoped)
 * because these tasks represent work-in-progress markers the model
 * pushes onto itself — they don't need to survive process restarts.
 *
 * Each task has:
 *   - id:          ascending string
 *   - subject:     short imperative title
 *   - description: longer explanation (optional)
 *   - activeForm:  present-continuous label shown while running
 *   - status:      pending | in_progress | completed | stopped
 *   - output:      free-form text the task has produced so far
 *   - metadata:    arbitrary
 *   - times:       created / updated / completed
 */

import { randomBytes } from "crypto"

export type TaskStatus = "pending" | "in_progress" | "completed" | "stopped"

export interface TrackedTask {
  id: string
  sessionID: string
  subject: string
  description?: string
  activeForm?: string
  status: TaskStatus
  output: string
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  completedAt?: number
}

const bySession = new Map<string, Map<string, TrackedTask>>()

function newId(): string {
  return `task_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
}

function bucket(sessionID: string): Map<string, TrackedTask> {
  let b = bySession.get(sessionID)
  if (!b) {
    b = new Map()
    bySession.set(sessionID, b)
  }
  return b
}

export namespace TaskTracker {
  export function create(input: {
    sessionID: string
    subject: string
    description?: string
    activeForm?: string
    metadata?: Record<string, unknown>
  }): TrackedTask {
    const now = Date.now()
    const task: TrackedTask = {
      id: newId(),
      sessionID: input.sessionID,
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      status: "pending",
      output: "",
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    }
    bucket(input.sessionID).set(task.id, task)
    return task
  }

  export function get(sessionID: string, id: string): TrackedTask | undefined {
    return bucket(sessionID).get(id)
  }

  export function list(sessionID: string, filter?: { status?: TaskStatus }): TrackedTask[] {
    const tasks = Array.from(bucket(sessionID).values())
    return filter?.status ? tasks.filter((t) => t.status === filter.status) : tasks
  }

  export function update(
    sessionID: string,
    id: string,
    patch: Partial<Pick<TrackedTask, "subject" | "description" | "activeForm" | "status" | "metadata">>,
  ): TrackedTask | undefined {
    const task = bucket(sessionID).get(id)
    if (!task) return undefined
    if (patch.subject !== undefined) task.subject = patch.subject
    if (patch.description !== undefined) task.description = patch.description
    if (patch.activeForm !== undefined) task.activeForm = patch.activeForm
    if (patch.metadata !== undefined) task.metadata = { ...task.metadata, ...patch.metadata }
    if (patch.status !== undefined) {
      task.status = patch.status
      if (patch.status === "completed" || patch.status === "stopped") {
        task.completedAt = Date.now()
      }
    }
    task.updatedAt = Date.now()
    return task
  }

  export function appendOutput(sessionID: string, id: string, chunk: string): TrackedTask | undefined {
    const task = bucket(sessionID).get(id)
    if (!task) return undefined
    task.output = task.output.length === 0 ? chunk : `${task.output}\n${chunk}`
    task.updatedAt = Date.now()
    return task
  }

  export function stop(sessionID: string, id: string, reason?: string): TrackedTask | undefined {
    const task = bucket(sessionID).get(id)
    if (!task) return undefined
    task.status = "stopped"
    task.completedAt = Date.now()
    task.updatedAt = Date.now()
    if (reason) task.output = task.output ? `${task.output}\n[stopped] ${reason}` : `[stopped] ${reason}`
    return task
  }

  export function remove(sessionID: string, id: string): boolean {
    return bucket(sessionID).delete(id)
  }

  /** Test helper. */
  export function _resetForTests() {
    bySession.clear()
  }
}
