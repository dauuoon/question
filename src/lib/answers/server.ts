import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isInvalidAuthSession } from "../auth/session-error";
import { answerRevisionSchema } from "./revision";

export class AnswerError extends Error {
  constructor(readonly code:string,readonly status=503) {
    super(code);
    this.name="AnswerError";
  }
}

export const answerRowSchema=z.object({
  question_id:z.uuid(),original_answer:z.string(),refined_answer:z.string().nullable(),
  refinement_used:z.boolean(),current_answer_version:z.enum(["original","refined"]),
  updated_at:answerRevisionSchema,
}).strict();
export type AnswerRow=z.infer<typeof answerRowSchema>;

export async function requireActiveParticipant(caller:SupabaseClient,signal:AbortSignal):Promise<string> {
  const auth=await caller.auth.getUser();
  if(auth.error || !auth.data.user) {
    if(auth.error && !isInvalidAuthSession(auth.error)) throw new AnswerError("ANSWER-DB");
    throw new AnswerError("ANSWER-AUTH",403);
  }
  const profile=await caller.from("profiles").select("role,status")
    .eq("id",auth.data.user.id).abortSignal(signal).maybeSingle();
  if(profile.error) throw new AnswerError("ANSWER-DB");
  if(profile.data?.role!=="participant" || profile.data.status!=="active") throw new AnswerError("ANSWER-AUTH",403);
  return auth.data.user.id;
}

export async function requireEditableQuestion(
  caller:SupabaseClient,userId:string,questionId:string,signal:AbortSignal,
):Promise<{session_id:string}> {
  const question=await caller.from("questions")
    .select("id,session_id,status,is_active_version,question_kind")
    .eq("id",questionId).abortSignal(signal).maybeSingle();
  if(question.error) throw new AnswerError("ANSWER-DB");
  if(!question.data) throw new AnswerError("ANSWER-AUTH",403);
  const parsedQuestion=z.object({
    id:z.uuid(),session_id:z.uuid(),status:z.enum(["unprocessed","answered","skipped"]),
    is_active_version:z.boolean(),question_kind:z.enum(["original","regenerated","followup"]),
  }).strict().safeParse(question.data);
  if(!parsedQuestion.success) throw new AnswerError("ANSWER-DB");
  const session=await caller.from("sessions").select("status")
    .eq("id",parsedQuestion.data.session_id).eq("participant_id",userId)
    .abortSignal(signal).maybeSingle();
  if(session.error) throw new AnswerError("ANSWER-DB");
  if(!session.data) throw new AnswerError("ANSWER-AUTH",403);
  if(parsedQuestion.data.question_kind!=="followup") {
    const followup=await caller.from("questions").select("id")
      .eq("parent_question_id",parsedQuestion.data.id).eq("question_kind","followup")
      .abortSignal(signal).limit(1);
    if(followup.error) throw new AnswerError("ANSWER-DB");
    if(followup.data.length) throw new AnswerError("ANSWER-LOCKED",409);
  }
  if(session.data.status!=="in_progress" || parsedQuestion.data.status==="skipped" ||
    (!parsedQuestion.data.is_active_version && parsedQuestion.data.question_kind!=="followup")) {
    throw new AnswerError("ANSWER-STATE",409);
  }
  return {session_id:parsedQuestion.data.session_id};
}

export async function readAnswer(
  caller:SupabaseClient,questionId:string,signal:AbortSignal,
):Promise<AnswerRow|null> {
  const result=await caller.from("answers")
    .select("question_id,original_answer,refined_answer,refinement_used,current_answer_version,updated_at")
    .eq("question_id",questionId).abortSignal(signal).maybeSingle();
  if(result.error) throw new AnswerError("ANSWER-DB");
  if(!result.data) return null;
  const parsed=answerRowSchema.safeParse(result.data);
  if(!parsed.success || (parsed.data.current_answer_version==="refined" &&
    (!parsed.data.refinement_used || parsed.data.refined_answer===null))) throw new AnswerError("ANSWER-DB");
  return parsed.data;
}
