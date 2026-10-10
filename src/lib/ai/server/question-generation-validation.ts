import "server-only";
import { z } from "zod";
import { QUESTION_GENERATION_SCHEMA } from "../schemas/question-generation-v2.0";
import { QuestionGenerationError } from "../question-generation-contract";
import { draftInputSchema } from "../context-draft-contract";
import { REFLECTION_CONTEXTS } from "../../constants/research-options";

const fields = QUESTION_GENERATION_SCHEMA.schema.properties.questions.items.properties;
const regionFields = fields.target.properties.region.anyOf[0].properties;
const regionSchema = z.object({
  x: z.number().min(regionFields.x.minimum).max(regionFields.x.maximum),
  y: z.number().min(regionFields.y.minimum).max(regionFields.y.maximum),
  width: z.number().min(regionFields.width.minimum).max(regionFields.width.maximum),
  height: z.number().min(regionFields.height.minimum).max(regionFields.height.maximum),
}).strict();
export const candidateSchema = z.object({
  candidate_rank: z.number().int().min(fields.candidate_rank.minimum).max(fields.candidate_rank.maximum),
  question_text: z.string(),
  content_principle: z.enum(fields.content_principle.enum),
  question_type: z.enum(fields.question_type.enum),
  related_contexts: z.array(z.string()),
  answer_guides: z.array(z.string()).min(fields.answer_guides.minItems).max(fields.answer_guides.maxItems),
  target: z.object({
    type: z.enum(fields.target.properties.type.enum),
    image_indices: z.array(z.number().int().min(fields.target.properties.image_indices.items.minimum)
      .max(fields.target.properties.image_indices.items.maximum))
      .min(fields.target.properties.image_indices.minItems).max(fields.target.properties.image_indices.maxItems),
    region: regionSchema.nullable(),
  }).strict(),
}).strict();
export type QuestionCandidate = z.infer<typeof candidateSchema>;
const outputSchema = z.object({
  questions: z.array(candidateSchema).length(QUESTION_GENERATION_SCHEMA.schema.properties.questions.minItems),
}).strict();
export const imageSnapshotSchema = z.array(z.object({
  id: z.uuid(), sort_order: z.number().int().nonnegative(),
  storage_path: z.string().min(1), mime_type: z.enum(["image/png", "image/jpeg"]),
  file_size: z.number().int().positive().max(10 * 1024 * 1024),
  width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable(),
}).strict()).min(1).max(10).refine((images) =>
  new Set(images.map((image) => image.id)).size === images.length &&
  new Set(images.map((image) => image.storage_path)).size === images.length &&
  images.every((image, index) => index === 0 || images[index - 1].sort_order < image.sort_order));
export const attemptSchema = z.object({
  id: z.uuid(), session_id: z.uuid(), request_id: z.uuid(),
  status: z.enum(["running", "completed", "failed"]),
  input_snapshot: draftInputSchema,
  image_snapshot: imageSnapshotSchema,
  requested_question_count: z.number().int().min(1).max(5),
  validated_candidates: z.array(candidateSchema).length(5).nullable(),
}).strict();
export type GenerationAttempt = z.infer<typeof attemptSchema>;

const hierarchy: Record<QuestionCandidate["content_principle"], readonly string[]> = {
  "사고의 자각과 외재화": fields.question_type.enum.slice(0, 4),
  "사고의 근거와 구조 검토": fields.question_type.enum.slice(4, 10),
  "사고의 확장과 재구성": fields.question_type.enum.slice(10, 18),
  "탐색적 실행과 검증": fields.question_type.enum.slice(18, 22),
  "자기점검과 조절": fields.question_type.enum.slice(22),
};

export function normalizeRelatedContexts(values: string[], selected: string[]): string[] {
  const ids = values.map((value) => {
    const context = REFLECTION_CONTEXTS.find((item) => item.id === value || item.label === value);
    if (!context || !selected.includes(context.id)) throw new QuestionGenerationError("QGEN-CONTEXT");
    return context.id;
  });
  if (new Set(ids).size !== ids.length) throw new QuestionGenerationError("QGEN-CONTEXT");
  return ids;
}

export function validateCandidateDetails(candidate:QuestionCandidate,
  input:GenerationAttempt["input_snapshot"],images:GenerationAttempt["image_snapshot"]) {
  if(!candidate.question_text.trim()||candidate.question_text.includes("\0")||
    !hierarchy[candidate.content_principle].includes(candidate.question_type)||
    candidate.answer_guides.some(guide=>!guide.trim()||guide.includes("\0"))) {
    throw new QuestionGenerationError("QGEN-VALIDATION");
  }
  const contexts=normalizeRelatedContexts(candidate.related_contexts,input.context_ids);
  const target=candidate.target,indices=target.image_indices;
  if(indices.some(i=>i>images.length)||new Set(indices).size!==indices.length||
    (target.type==="multi_image"?indices.length<2:indices.length!==1))throw new QuestionGenerationError("QGEN-VALIDATION");
  if(target.type==="region") {
    const r=target.region;
    if(!r||r.width<=0||r.height<=0||r.x+r.width>1||r.y+r.height>1)throw new QuestionGenerationError("QGEN-VALIDATION");
  } else if(target.region!==null)throw new QuestionGenerationError("QGEN-VALIDATION");
  return contexts;
}

export function validateQuestionOutput(output: unknown, attempt: GenerationAttempt): QuestionCandidate[] {
  const parsed = outputSchema.safeParse(output);
  if (!parsed.success) throw new QuestionGenerationError("QGEN-VALIDATION");
  const candidates = parsed.data.questions;
  // Leave room for PostgreSQL jsonb whitespace in its 256 KiB payload limit.
  if (Buffer.byteLength(JSON.stringify(candidates)) > 240 * 1024) throw new QuestionGenerationError("QGEN-VALIDATION");
  const texts = new Set<string>();
  let topRelated = false;
  for (const [index, candidate] of candidates.entries()) {
    const text = candidate.question_text.trim();
    if (candidate.candidate_rank !== index + 1 || texts.has(text)) throw new QuestionGenerationError("QGEN-VALIDATION");
    texts.add(text);
    const contexts = validateCandidateDetails(candidate,attempt.input_snapshot,attempt.image_snapshot);
    if (candidate.candidate_rank <= attempt.requested_question_count && contexts.length > 0) topRelated = true;
  }
  if (!topRelated) throw new QuestionGenerationError("QGEN-CONTEXT");
  // Preserve exact AI related_contexts; the DB stores the checked stable IDs separately as context_ids.
  return candidates;
}
