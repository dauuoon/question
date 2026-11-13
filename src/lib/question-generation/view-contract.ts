import { z } from "zod";
import { answerRevisionSchema } from "../answers/revision";
import { questionActionCapabilitiesSchema, questionActionCommitSchema } from "./actions-contract";
import { answerFormSchema, answerFieldsSchema, answerFieldsText, answerFieldsMatchForm } from "../answers/form";

export const questionCountSchema = z.number().int().min(1).max(5);
export const selectableQuestionCountSchema = z.number().int().min(2).max(5);
const targetSchema = z.object({
  image_id: z.uuid(), x: z.number().min(0).max(1).nullable(), y: z.number().min(0).max(1).nullable(),
  width: z.number().min(0).max(1).nullable(), height: z.number().min(0).max(1).nullable(),
  sort_order: z.number().int().nonnegative(),
}).strict().superRefine((target, ctx) => {
  const values = [target.x, target.y, target.width, target.height];
  if (values.every((value) => value === null)) return;
  if (values.some((value) => value === null) || target.width === 0 || target.height === 0 ||
    (target.x ?? 0) + (target.width ?? 0) > 1 || (target.y ?? 0) + (target.height ?? 0) > 1) {
    ctx.addIssue({ code: "custom", message: "Invalid persisted target region" });
  }
});
const questionSchema = z.object({
  id: z.uuid(), slot_index: questionCountSchema, question_text: z.string().refine((text) => text.trim().length > 0),
  status:z.enum(["unprocessed","answered","skipped"]),
  regeneration_index:z.number().int().min(0).max(2),
  answer_form:answerFormSchema.nullable().optional(),
  targets: z.array(targetSchema).min(1).max(10),
  answer: z.object({
    original_answer:z.string(),refined_answer:z.string().nullable(),
    original_answer_fields:answerFieldsSchema.nullable().optional(),
    refinement_used:z.boolean(),current_answer_version:z.enum(["original","refined"]),updated_at:answerRevisionSchema.nullable(),
  }).strict(),
  followup_question:z.object({
    id:z.uuid(),question_text:z.string().min(1),status:z.enum(["unprocessed","answered","skipped"]),
    answer_form:answerFormSchema.nullable().optional(),
    answer:z.object({
      original_answer:z.string(),refined_answer:z.string().nullable(),refinement_used:z.boolean(),
      original_answer_fields:answerFieldsSchema.nullable().optional(),
      current_answer_version:z.enum(["original","refined"]),updated_at:answerRevisionSchema.nullable(),
    }).strict(),
  }).strict().nullable().default(null),
  last_followup_request:z.object({
    request_id:z.uuid(),status:z.enum(["reserved","dispatch_started","generated","no_followup","failed","outcome_unknown"]),
    answer_snapshot:z.string(),created_at:z.string(),prompt_version:z.string(),model_id:z.string().nullable(),
    input_tokens:z.number().int().nonnegative().nullable(),output_tokens:z.number().int().nonnegative().nullable(),
  }).strict().nullable().default(null),
}).strict();
const imageSchema = z.object({
  id: z.uuid(), sort_order: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable(),
  signed_url: z.string().url(),
}).strict();
export const generationViewSchema = z.object({
  session_id: z.uuid(),
  state: z.enum(["editable", "running", "recovery", "completed"]),
  requested_question_count: questionCountSchema,
  failed_request_id: z.uuid().nullable(),
  generation_elapsed_ms: z.number().int().nonnegative().nullable().optional(),
  answer_editable:z.boolean(),
  followup_enabled:z.boolean().default(false),
  readability_improved:z.boolean().default(false),
  answer_forms_available:z.boolean().optional(),
  question_actions:questionActionCapabilitiesSchema,
  questions: z.array(questionSchema).max(5),
  images: z.array(imageSchema).max(10),
}).strict().superRefine((view, ctx) => {
  for(const question of view.questions.flatMap(question=>[question,
    ...(question.followup_question?[question.followup_question]:[])])) {
    const fields=question.answer.original_answer_fields;
    if(fields&&(!question.answer_form || !answerFieldsMatchForm(question.answer_form,fields)||
      answerFieldsText(fields)!==question.answer.original_answer)) {
      ctx.addIssue({code:"custom",message:"Answer fields do not match their form or user text"});
    }
  }
  if (view.state === "completed" && (view.questions.length !== view.requested_question_count ||
    new Set(view.questions.map((q) => q.id)).size !== view.questions.length ||
    view.questions.some((q, i) => q.slot_index !== i + 1))) {
    ctx.addIssue({ code: "custom", message: "Invalid saved question slots" });
  }
  if (view.state !== "completed" && (view.questions.length !== 0 || view.images.length !== 0 || view.answer_editable)) {
    ctx.addIssue({ code: "custom", message: "Incomplete question result" });
  }
  if(view.questions.some((question)=>question.answer.current_answer_version==="refined" &&
    (!question.answer.refinement_used || question.answer.refined_answer===null || question.answer.updated_at===null))) {
    ctx.addIssue({code:"custom",message:"Invalid current answer version"});
  }
  if (view.state === "completed") {
    const ids = new Set(view.images.map((image) => image.id));
    if (ids.size !== view.images.length || new Set(view.images.map((image) => image.sort_order)).size !== view.images.length ||
      view.images.some((image, index) => index > 0 && view.images[index - 1].sort_order >= image.sort_order) ||
      view.questions.some((question) => question.targets.some((target, index) =>
        !ids.has(target.image_id) || (index > 0 && question.targets[index - 1].sort_order >= target.sort_order)))) {
      ctx.addIssue({ code: "custom", message: "Question target references invalid images" });
    }
  }
});
export const questionActionResponseSchema = questionActionCommitSchema.extend({
  view:generationViewSchema,
  activity_recorded:z.boolean(),
}).strict();
export type GenerationView = z.infer<typeof generationViewSchema>;
export type DisplayQuestion = GenerationView["questions"][number];
export type DisplayImage = GenerationView["images"][number];
export type DisplayTarget = DisplayQuestion["targets"][number];
