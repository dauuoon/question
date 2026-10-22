import { z } from "zod";

export const SESSION_BRIEFING_PROMPT_VERSION = "session-design-briefing-v1.5";
export const SESSION_BRIEFING_SCHEMA_VERSION = "why_box_session_design_briefing_v1_0";

export const briefingStateSchema = z.enum([
  "blocked",
  "ready",
  "dispatch_started",
  "completed",
  "failed",
  "dispatch_unknown",
]);

const selectedAnswerSchema = z.object({
  original: z.string(),
  refined: z.string().nullable(),
  current_version: z.enum(["original", "refined"]),
  selected: z.string().min(1),
}).strict();

export const briefingInputSchema = z.object({
  session_id: z.uuid(),
  design_context: z.object({
    primary_category_id: z.string().nullable(),
    subcategory_id: z.string().nullable(),
    other_category_text: z.string().nullable(),
    stage_id: z.string().nullable(),
    additional_context: z.string().nullable(),
  }).strict(),
  context_ids: z.array(z.string()),
  answered_questions: z.array(z.object({
    question_id: z.uuid(),
    slot_index: z.number().int().min(1).max(5),
    question_text: z.string().min(1),
    answer: selectedAnswerSchema,
    followup: z.object({
      session_id: z.uuid(),
      question_id: z.uuid(),
      parent_question_id: z.uuid(),
      question_text: z.string().min(1),
      answer: selectedAnswerSchema,
    }).strict().optional(),
  }).strict()).min(1).max(5),
}).strict().superRefine((input, context) => {
  if (!input.answered_questions.some((question) => question.answer.selected.trim().length > 0)) {
    context.addIssue({ code: "custom", message: "At least one nonblank selected answer is required." });
  }
  for (const question of input.answered_questions) {
    for (const answer of [question.answer, ...(question.followup ? [question.followup.answer] : [])]) {
      const selected = answer.current_version === "refined" ? answer.refined : answer.original;
      if (!selected?.trim() || selected !== answer.selected) {
        context.addIssue({ code: "custom", message: "Selected answer must match its final version." });
      }
    }
    if (question.followup && (question.followup.session_id !== input.session_id ||
      question.followup.parent_question_id !== question.question_id ||
      question.followup.question_id === question.question_id)) {
      context.addIssue({ code: "custom", message: "Follow-up must belong to its parent and session." });
    }
  }
  const ids = input.answered_questions.flatMap(question =>
    [question.question_id, ...(question.followup ? [question.followup.question_id] : [])]);
  if (new Set(ids).size !== ids.length ||
    new Set(input.answered_questions.map(question => question.slot_index)).size !== input.answered_questions.length) {
    context.addIssue({ code: "custom", message: "Question identities and slots must be unique." });
  }
});

export const briefingResultSchema = z.object({
  briefing_text: z.string().trim().min(1).max(16000),
}).strict();

export const briefingRequestSchema = z.object({
  accepted: z.boolean(),
  request_id: z.uuid(),
  state: briefingStateSchema,
  attempt_number: z.number().int().min(0).max(2),
  retry_of_request_id: z.uuid().nullable(),
  missing_question_ids: z.array(z.uuid()),
  has_answer: z.boolean(),
  input_snapshot: briefingInputSchema.nullable(),
  replayed: z.boolean(),
}).strict().superRefine((request, context) => {
  if (request.state === "blocked" && request.accepted) {
    context.addIssue({ code: "custom", message: "A blocked request cannot be accepted." });
  }
  if (request.state !== "blocked" && request.attempt_number === 0) {
    context.addIssue({ code: "custom", message: "An active request must have an attempt number." });
  }
  if (request.state === "blocked" && request.input_snapshot !== null) {
    context.addIssue({ code: "custom", message: "Blocked requests cannot include an input snapshot." });
  }
});

export const briefingFinishSchema = z.object({
  request_id: z.uuid(),
  state: z.literal("completed"),
  replayed: z.boolean(),
}).strict();

export const briefingVersionSaveSchema = z.object({
  saved: z.boolean(),
  revision: z.number().int().positive().optional(),
  current_revision: z.number().int().nonnegative().optional(),
}).strict().superRefine((result, context) => {
  if (result.saved && result.revision === undefined) {
    context.addIssue({ code: "custom", message: "A successful save must return its revision." });
  }
  if (!result.saved && result.current_revision === undefined) {
    context.addIssue({ code: "custom", message: "A conflict must return the current revision." });
  }
});

export type BriefingInput = z.infer<typeof briefingInputSchema>;
export type BriefingResult = z.infer<typeof briefingResultSchema>;
export type BriefingRequest = z.infer<typeof briefingRequestSchema>;
export type BriefingRequestState = z.infer<typeof briefingStateSchema>;
