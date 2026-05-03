/**
 * AskUserQuestion — simplified single-question wrapper.
 *
 * Phase 13: a thin, always-available alias over the existing Question
 * system used by QuestionTool. QuestionTool is gated behind flags and
 * takes an array of structured question objects; this tool takes a
 * single question string + optional multiple-choice options, which is
 * what the model needs in 95% of cases.
 */

import z from "zod"
import { Tool } from "./tool"
import { Question } from "../question"

export const AskUserQuestionTool = Tool.define("ask_user_question", {
  description: `Ask the user a single question and wait for the answer.

Use sparingly — only when you genuinely cannot proceed without the user's input. Prefer making a reasonable choice and flagging it than stopping to ask.

If options are provided, the user picks one of them. If not, the user replies in free-form text.`,
  parameters: z.object({
    question: z.string().describe("The question text"),
    header: z.string().optional().describe("Short header shown above the question (e.g., the topic)"),
    options: z
      .array(z.object({ label: z.string(), description: z.string().optional() }))
      .optional()
      .describe("Multiple-choice options. If omitted, the user answers in free-form."),
  }),
  async execute(params, ctx) {
    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: [
        {
          question: params.question,
          header: params.header ?? "Question",
          custom: !params.options || params.options.length === 0,
          options: (params.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })),
        },
      ],
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })
    const answer = answers[0] ?? []
    const formatted = answer.length === 0 ? "Unanswered" : answer.join(", ")
    return {
      title: `Asked: ${params.question.slice(0, 60)}${params.question.length > 60 ? "…" : ""}`,
      output: `User answered: ${formatted}`,
      metadata: { answer, rawAnswers: answers },
    }
  },
})
