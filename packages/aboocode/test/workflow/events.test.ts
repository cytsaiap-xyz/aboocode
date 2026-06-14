import { test, expect } from "bun:test"
import { WorkflowEvents } from "../../src/workflow/events"

test("event definitions exist with correct types", () => {
  expect(WorkflowEvents.Started.type).toBe("workflow.started")
  expect(WorkflowEvents.Progress.type).toBe("workflow.progress")
  expect(WorkflowEvents.Completed.type).toBe("workflow.completed")
  // schema accepts a representative payload
  expect(() => WorkflowEvents.Progress.properties.parse({ runId: "r", kind: "log", message: "hi" })).not.toThrow()
})
