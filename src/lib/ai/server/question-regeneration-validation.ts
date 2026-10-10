import "server-only";
import { z } from "zod";
import { candidateSchema,imageSnapshotSchema,validateCandidateDetails } from "./question-generation-validation";
import { draftInputSchema } from "../context-draft-contract";
import { QuestionActionError } from "../../question-generation/actions-contract";

export const REGENERATION_VALIDATION_VERSION="question-regeneration-validation-v1.0";
export const REGENERATION_SIMILARITY_THRESHOLD=0.82;
export const regenerationCandidateSchema=candidateSchema.omit({candidate_rank:true}).extend({
  question_text:z.string().trim().min(1).max(2000),
  answer_guides:z.array(z.string().trim().min(1).max(500)).max(3),
});
export const regenerationOutputSchema=z.object({question:regenerationCandidateSchema}).strict();
export const regenerationAttemptSchema=z.object({
  id:z.uuid(),session_id:z.uuid(),request_id:z.uuid(),
  status:z.enum(["reserved","dispatch_started","staged","committed","failed","outcome_unknown","stale"]),
  question_id:z.uuid(),root_question_id:z.uuid(),slot_index:z.number().int().min(1).max(5),
  regeneration_index:z.number().int().min(0).max(1),
  input_snapshot:draftInputSchema,image_snapshot:imageSnapshotSchema,
  exclusion_snapshot:z.array(z.object({id:z.uuid(),question_text:z.string().min(1)}).strict()).min(1).max(100),
}).strict();
export type RegenerationAttempt=z.infer<typeof regenerationAttemptSchema>;
export type RegenerationCandidate=z.infer<typeof regenerationCandidateSchema>;

export function normalizedQuestion(text:string) {
  return text.normalize("NFKC").toLocaleLowerCase("ko").replace(/[^\p{L}\p{N}]/gu,"");
}
export function questionSimilarity(first:string,second:string) {
  const a=normalizedQuestion(first),b=normalizedQuestion(second);
  if(a===b)return 1;
  const grams=(text:string)=>new Set(Array.from({length:Math.max(0,text.length-2)},(_,i)=>text.slice(i,i+3)));
  const left=grams(a),right=grams(b);
  if(!left.size||!right.size)return 0;
  return 2*[...left].filter(g=>right.has(g)).length/(left.size+right.size);
}
export function validateRegenerationOutput(output:unknown,attempt:RegenerationAttempt) {
  const parsed=regenerationOutputSchema.safeParse(output);
  if(!parsed.success||Buffer.byteLength(JSON.stringify(output))>16_384)throw new QuestionActionError("QR-VALIDATION",502);
  const question=parsed.data.question;
  try {
    question.related_contexts=validateCandidateDetails({...question,candidate_rank:1},attempt.input_snapshot,attempt.image_snapshot);
    if(!question.related_contexts.length)throw new QuestionActionError("QR-VALIDATION",502);
  } catch {throw new QuestionActionError("QR-VALIDATION",502);}
  const comparisons=attempt.exclusion_snapshot.map(previous=>({
    question_id:previous.id,score:questionSimilarity(question.question_text,previous.question_text),
  }));
  if(comparisons.some(item=>item.score>=REGENERATION_SIMILARITY_THRESHOLD))throw new QuestionActionError("QR-DUPLICATE",422);
  return {candidate:{...question,candidate_rank:1},validation:{
    version:REGENERATION_VALIDATION_VERSION,threshold:REGENERATION_SIMILARITY_THRESHOLD,comparisons,
  }};
}
