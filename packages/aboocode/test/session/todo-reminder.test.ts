import { describe, expect, test } from "bun:test"
import { TodoReminder } from "../../src/session/todo-reminder"

describe("session.todo-reminder", () => {
  test("not due before TURNS_SINCE_WRITE ticks", () => {
    const id = "ses_todo_rem_1"
    TodoReminder.reset(id)
    for (let i = 0; i < TodoReminder.TURNS_SINCE_WRITE - 1; i++) TodoReminder.tick(id)
    expect(TodoReminder.due(id)).toBe(false)
  })

  test("due after TURNS_SINCE_WRITE ticks without a write", () => {
    const id = "ses_todo_rem_2"
    TodoReminder.reset(id)
    for (let i = 0; i < TodoReminder.TURNS_SINCE_WRITE; i++) TodoReminder.tick(id)
    expect(TodoReminder.due(id)).toBe(true)
  })

  test("recordWrite resets the counter", () => {
    const id = "ses_todo_rem_3"
    TodoReminder.reset(id)
    for (let i = 0; i < TodoReminder.TURNS_SINCE_WRITE; i++) TodoReminder.tick(id)
    TodoReminder.recordWrite(id)
    expect(TodoReminder.due(id)).toBe(false)
  })

  test("markReminded suppresses for TURNS_BETWEEN_REMINDERS", () => {
    const id = "ses_todo_rem_4"
    TodoReminder.reset(id)
    for (let i = 0; i < TodoReminder.TURNS_SINCE_WRITE; i++) TodoReminder.tick(id)
    TodoReminder.markReminded(id)
    expect(TodoReminder.due(id)).toBe(false)
    for (let i = 0; i < TodoReminder.TURNS_BETWEEN_REMINDERS; i++) TodoReminder.tick(id)
    expect(TodoReminder.due(id)).toBe(true)
  })
})
