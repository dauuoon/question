import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readAnswer, requireActiveParticipant, requireEditableQuestion, AnswerError } from "@/lib/answers/server";
import { readGenerationView } from "@/lib/question-generation/read";
import { readQuestionFollowupAccess } from "@/lib/question-generation/followup-access";
import { QUESTION_FOLLOWUP_PROMPT_VERSION } from "@/lib/ai/prompts/question-followup-v1.0";
import {
  QuestionFollowupError, questionFollowupErrorMessages, questionFollowupRequestSchema,
} from "@/lib/ai/question-followup-contract";
import { questionFollowupConfig, QUESTION_FOLLOWUP_TIMEOUT_MS } from "@/lib/ai/server/question-followup-config";
import { generateQuestionFollowup } from "@/lib/ai/server/question-followup";

export const runtime = "nodejs";
export const maxDuration = 70;
const headers = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 4_096;

const requestRecordSchema = z.object({
  id: z.uuid(), request_id: z.uuid(),
  status: z.enum(["reserved", "dispatch_started", "generated", "no_followup", "failed", "outcome_unknown"]),
  result_question_id: z.uuid().nullable(), answer_snapshot: z.string(),
}).passthrough();
const finishRequestSchema = requestRecordSchema.extend({ request_id: z.uuid() });

function errorResponse(error: unknown) {
  const safe = error instanceof QuestionFollowupError ? error :
    error instanceof AnswerError ? new QuestionFollowupError(
      error.code === "ANSWER-AUTH" ? "FOLLOWUP-AUTH" :
        error.code === "ANSWER-STATE" || error.code === "ANSWER-LOCKED" ? "FOLLOWUP-STATE" : "FOLLOWUP-DB",
      error.status,
    ) : new QuestionFollowupError("FOLLOWUP-DB");
  console.error(`WHY BOX question follow-up: ${safe.code}`);
  return NextResponse.json({
    errorCode: safe.code,
    message: questionFollowupErrorMessages[safe.code] ?? questionFollowupErrorMessages["FOLLOWUP-DB"],
  }, { status: safe.status, headers });
}

async function finishFailure(admin: ReturnType<typeof createSupabaseAdminClient>, requestId: string,
  code: string, unknown: boolean) {
  const result = await admin.rpc("finish_question_followup", {
    p_request_id: requestId,
    p_outcome: unknown ? "outcome_unknown" : "failed",
    p_question_text: null,
    p_model_id: null,
    p_input_tokens: null,
    p_output_tokens: null,
    p_failure_code: code,
  });
  if (result.error) console.error("WHY BOX question follow-up: failure persistence FOLLOWUP-DB");
}

export async function POST(request: NextRequest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUESTION_FOLLOWUP_TIMEOUT_MS + 5_000);
  try {
    const protocol = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.slice(0, -1);
    const host = request.headers.get("host");
    if (!host || request.headers.get("origin") !== `${protocol}://${host}`) {
      throw new QuestionFollowupError("FOLLOWUP-AUTH", 403);
    }
    const reader = request.body?.getReader();
    if (!reader) throw new QuestionFollowupError("FOLLOWUP-INPUT", 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new QuestionFollowupError("FOLLOWUP-INPUT", 413);
      }
      chunks.push(chunk.value);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new QuestionFollowupError("FOLLOWUP-INPUT", 400); }
    const parsed = questionFollowupRequestSchema.safeParse(body);
    if (!parsed.success) throw new QuestionFollowupError("FOLLOWUP-INPUT", 400);
    const input = parsed.data;
    const caller = await createSupabaseServerClient();
    const userId = await requireActiveParticipant(caller, controller.signal);
    if (!(await readQuestionFollowupAccess(caller, userId)).enabled) {
      throw new QuestionFollowupError("FOLLOWUP-AUTH", 403);
    }
    const { session_id: sessionId } = await requireEditableQuestion(caller, userId, input.question_id, controller.signal);
    const answer = await readAnswer(caller, input.question_id, controller.signal);
    if (!answer || answer.updated_at !== input.expected_updated_at) {
      throw new QuestionFollowupError("FOLLOWUP-STALE", 409);
    }
    const answerText = answer.current_answer_version === "refined" ?
      answer.refined_answer ?? "" : answer.original_answer;
    if (!answerText.trim()) throw new QuestionFollowupError("FOLLOWUP-EMPTY", 422);
    const answerHash = createHash("sha256").update(answerText, "utf8").digest("hex");
    const admin = createSupabaseAdminClient();
    const begun = await admin.rpc("begin_question_followup", {
      p_session_id: sessionId,
      p_question_id: input.question_id,
      p_request_id: input.request_id,
      p_participant_id: userId,
      p_expected_answer_updated_at: answer.updated_at,
      p_answer_hash: answerHash,
      p_answer_snapshot: answerText,
      p_prompt_version: QUESTION_FOLLOWUP_PROMPT_VERSION,
    });
    if (begun.error) {
      if (begun.error.code === "40001") throw new QuestionFollowupError("FOLLOWUP-STALE", 409);
      if (begun.error.code === "54000") throw new QuestionFollowupError("FOLLOWUP-ALREADY", 409);
      if (begun.error.code === "23505") throw new QuestionFollowupError("FOLLOWUP-DUPLICATE", 409);
      if (begun.error.code === "55000") throw new QuestionFollowupError("FOLLOWUP-STATE", 409);
      if (begun.error.code === "42501") throw new QuestionFollowupError("FOLLOWUP-AUTH", 403);
      throw new QuestionFollowupError("FOLLOWUP-DB");
    }
    const record = requestRecordSchema.safeParse(begun.data);
    if (!record.success) throw new QuestionFollowupError("FOLLOWUP-DB");
    if (record.data.status === "generated" || record.data.status === "no_followup") {
      const view = await readGenerationView(caller, userId, sessionId);
      return NextResponse.json({ outcome: record.data.status, view, activity_recorded: true }, { headers });
    }
    if (record.data.status === "outcome_unknown") {
      const view = await readGenerationView(caller, userId, sessionId);
      return NextResponse.json({ outcome: record.data.status, view, activity_recorded: true }, { headers });
    }
    if (record.data.status === "failed") throw new QuestionFollowupError("FOLLOWUP-API", 502);
    if (record.data.request_id !== input.request_id || record.data.status !== "reserved") {
      return NextResponse.json({ outcome: "pending", request_id: record.data.request_id }, { status: 202, headers });
    }
    let config: ReturnType<typeof questionFollowupConfig>;
    try { config = questionFollowupConfig(); }
    catch (error) {
      await finishFailure(admin, record.data.id, "FOLLOWUP-CONFIG", false);
      throw error;
    }

    const dispatched = await admin.rpc("dispatch_question_followup", {
      p_request_id: record.data.id,
      p_model_id: config.model,
    });
    if (dispatched.error) throw new QuestionFollowupError("FOLLOWUP-DB");
    const dispatchState=z.object({request_id:z.uuid(),
      status:z.enum(["dispatch_started","generated","no_followup","failed","outcome_unknown"]),
      acquired:z.boolean()})
      .strict().safeParse(dispatched.data);
    if(!dispatchState.success)throw new QuestionFollowupError("FOLLOWUP-DB");
    if(dispatchState.data.status==="generated"||dispatchState.data.status==="no_followup"||
      dispatchState.data.status==="outcome_unknown") {
      const view=await readGenerationView(caller,userId,sessionId);
      return NextResponse.json({outcome:dispatchState.data.status,view,activity_recorded:true},{headers});
    }
    if(dispatchState.data.status==="failed")throw new QuestionFollowupError("FOLLOWUP-API",502);
    if(!dispatchState.data.acquired) {
      return NextResponse.json({outcome:"pending",request_id:record.data.request_id},{status:202,headers});
    }
    const session = await caller.from("sessions")
      .select("primary_category_id,subcategory_id,other_category_text,stage_id,additional_context")
      .eq("id", sessionId).eq("participant_id", userId).single();
    const question = await caller.from("questions")
      .select("id,question_text").eq("id", input.question_id).eq("session_id", sessionId).single();
    const contexts = await caller.from("session_contexts").select("context_id").eq("session_id", sessionId);
    if (session.error || question.error || contexts.error || !session.data || !question.data || !contexts.data) {
      await finishFailure(admin, record.data.id, "FOLLOWUP-DB", false);
      throw new QuestionFollowupError("FOLLOWUP-DB");
    }
    let generated: Awaited<ReturnType<typeof generateQuestionFollowup>>;
    try {
      generated = await generateQuestionFollowup(config, {
        question_text: question.data.question_text,
        answer_text: answerText,
        primary_category_id: session.data.primary_category_id,
        subcategory_id: session.data.subcategory_id,
        other_category_text: session.data.other_category_text,
        stage_id: session.data.stage_id,
        additional_context: session.data.additional_context,
        context_ids: contexts.data.map(item => item.context_id),
      }, controller.signal);
    } catch (error) {
      const safe = error instanceof QuestionFollowupError ? error : new QuestionFollowupError("FOLLOWUP-API", 502);
      const ambiguous = ["FOLLOWUP-TIMEOUT","FOLLOWUP-API","FOLLOWUP-UNKNOWN","FOLLOWUP-OUTPUT"].includes(safe.code);
      await finishFailure(admin, record.data.id, safe.code, ambiguous);
      throw safe;
    }
    if (controller.signal.aborted) {
      await finishFailure(admin, record.data.id, "FOLLOWUP-TIMEOUT", true);
      throw new QuestionFollowupError("FOLLOWUP-TIMEOUT", 504);
    }
    const finished = await admin.rpc("finish_question_followup", {
      p_request_id: record.data.id,
      p_outcome: generated.outcome,
      p_question_text: generated.followup_question,
      p_model_id: generated.model,
      p_input_tokens: generated.input_tokens,
      p_output_tokens: generated.output_tokens,
      p_failure_code: null,
    });
    if (finished.error) {
      await finishFailure(admin, record.data.id, "FOLLOWUP-DB", true);
      throw new QuestionFollowupError("FOLLOWUP-DB");
    }
    const completed = finishRequestSchema.safeParse(finished.data);
    if (!completed.success || !["generated", "no_followup"].includes(completed.data.status)) {
      throw new QuestionFollowupError("FOLLOWUP-DB");
    }

    const view = await readGenerationView(caller, userId, sessionId);
    return NextResponse.json({ outcome: completed.data.status, view, activity_recorded: true }, { headers });
  } catch (error) {
    if (controller.signal.aborted) {
      return errorResponse(new QuestionFollowupError("FOLLOWUP-TIMEOUT", 504));
    }
    if (error instanceof QuestionFollowupError &&
      ["FOLLOWUP-API", "FOLLOWUP-CONFIG", "FOLLOWUP-OUTPUT", "FOLLOWUP-RATE"].includes(error.code)) {
      return errorResponse(error);
    }
    return errorResponse(error);
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: NextRequest) {
  try {
    const requestId = request.nextUrl.searchParams.get("request_id");
    if (!z.uuid().safeParse(requestId).success) throw new QuestionFollowupError("FOLLOWUP-INPUT", 400);
    const caller = await createSupabaseServerClient();
    const userId = await requireActiveParticipant(caller, new AbortController().signal);
    if (!(await readQuestionFollowupAccess(caller, userId)).enabled) {
      throw new QuestionFollowupError("FOLLOWUP-AUTH", 403);
    }
    const record = await caller.from("question_followup_requests")
      .select("id,session_id,status,created_at").eq("request_id",requestId).eq("participant_id",userId).maybeSingle();
    if (record.error) throw new QuestionFollowupError("FOLLOWUP-DB");
    if (!record.data) throw new QuestionFollowupError("FOLLOWUP-AUTH",403);
    if (["reserved","dispatch_started"].includes(record.data.status)) {
      const age=Date.now()-Date.parse(record.data.created_at);
      if(record.data.status==="reserved"&&age>10_000) {
        const admin=createSupabaseAdminClient();
        const marked=await admin.rpc("finish_question_followup",{
          p_request_id:record.data.id,p_outcome:"failed",p_question_text:null,p_model_id:null,
          p_input_tokens:null,p_output_tokens:null,p_failure_code:"FOLLOWUP-NOT-DISPATCHED",
        });
        if(marked.error)throw new QuestionFollowupError("FOLLOWUP-DB");
        const parsed=finishRequestSchema.safeParse(marked.data);
        if(!parsed.success)throw new QuestionFollowupError("FOLLOWUP-DB");
        if(parsed.data.status==="reserved"||parsed.data.status==="dispatch_started") {
          return NextResponse.json({outcome:"pending",request_id:parsed.data.request_id},{status:202,headers});
        }
        const view=await readGenerationView(caller,userId,record.data.session_id);
        return NextResponse.json({outcome:parsed.data.status,view,activity_recorded:true},{headers});
      }
      if (age>QUESTION_FOLLOWUP_TIMEOUT_MS+10_000) {
        const admin=createSupabaseAdminClient();
        const marked=await admin.rpc("finish_question_followup",{
          p_request_id:record.data.id,p_outcome:"outcome_unknown",p_question_text:null,p_model_id:null,
          p_input_tokens:null,p_output_tokens:null,p_failure_code:"FOLLOWUP-TIMEOUT",
        });
        if(marked.error)throw new QuestionFollowupError("FOLLOWUP-DB");
        const parsed=finishRequestSchema.safeParse(marked.data);
        if(!parsed.success)throw new QuestionFollowupError("FOLLOWUP-DB");
        const view=await readGenerationView(caller,userId,record.data.session_id);
        return NextResponse.json({outcome:parsed.data.status,view,activity_recorded:true},{headers});
      }
      return NextResponse.json({outcome:"pending",request_id:requestId},{status:202,headers});
    }
    const view=await readGenerationView(caller,userId,record.data.session_id);
    return NextResponse.json({outcome:record.data.status,view,activity_recorded:true},{headers});
  } catch(error) {
    return errorResponse(error);
  }
}
