import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSessionBriefingProvider } from "@/lib/ai/server/session-briefing-provider";
import { runSessionBriefing, SessionBriefingProviderError } from "@/lib/ai/server/session-briefing-service";
import { AnswerError, requireActiveParticipant } from "@/lib/answers/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSessionBriefingRepository } from "@/lib/session-completion/briefing-repository";
import { hasSameOrigin, readJsonBody, SessionCompletionApiError } from "@/lib/session-completion/api";
import { refineCompletionAnswers } from "@/lib/session-completion/refinement-service";

export const runtime = "nodejs";
export const maxDuration = 180;

const requestSchema = z.object({
  request_id: z.uuid(),
  retry_of_request_id: z.uuid().nullable().optional(),
}).strict();
const headers = { "Cache-Control": "no-store" };

export async function POST(request: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  let requestId: string | undefined;
  let phase = "origin";
  try {
    if (!hasSameOrigin(request)) throw new SessionCompletionApiError("COMPLETION-AUTH", 403);
    phase = "input";
    const parsed = requestSchema.safeParse(await readJsonBody(request, 4096));
    if (!parsed.success) throw new SessionCompletionApiError("COMPLETION-INPUT", 400);
    requestId = parsed.data.request_id;
    const { sessionId } = await context.params;
    if (!z.uuid().safeParse(sessionId).success) throw new SessionCompletionApiError("COMPLETION-INPUT", 400);

    phase = "auth";
    const caller = await createSupabaseServerClient();
    const userId = await requireActiveParticipant(caller, AbortSignal.timeout(15_000));
    const { provider, mode } = createSessionBriefingProvider();

    phase = "briefing";
    const trusted=createSupabaseAdminClient();
    const repository = createSessionBriefingRepository(caller, trusted, userId);
    const result = await runSessionBriefing(repository, provider, {
      session_id: sessionId,
      request_id: requestId,
      retry_of_request_id: parsed.data.retry_of_request_id ?? null,
    },process.env.OPENAI_COMPLETION_REFINEMENT_ENABLED==="true"?
      input=>refineCompletionAnswers(trusted,userId,requestId!,input):undefined);
    const response = {
      request_id: result.request_id,
      state: result.state,
      attempt_number: result.attempt_number,
      retry_of_request_id: result.retry_of_request_id,
      missing_question_ids: result.missing_question_ids,
      has_answer: result.has_answer,
      replayed: result.replayed,
      provider_mode: mode,
    };
    const status = result.state === "blocked" ? 409 :
      result.state === "completed" ? 200 :
        result.state === "ready" || result.state === "dispatch_started" ? 202 :
          result.state === "dispatch_unknown" ? 504 : 502;
    return NextResponse.json(response, { status, headers });
  } catch (error) {
    const safe = error instanceof SessionCompletionApiError ? error :
      error instanceof SessionBriefingProviderError ? new SessionCompletionApiError(error.safeCode, 503) :
      error instanceof AnswerError ? new SessionCompletionApiError(error.code, error.status) :
        new SessionCompletionApiError("COMPLETION-DB", 503);
    console.error("WHY BOX session completion", { code: safe.code, phase, requestId });
    return NextResponse.json({ errorCode: safe.code }, { status: safe.status, headers });
  }

}

export async function GET(request:NextRequest,context:{params:Promise<{sessionId:string}>}) {
    try {
      const {sessionId}=await context.params;
      const requestId=request.nextUrl.searchParams.get("request_id");
      if(!z.uuid().safeParse(sessionId).success||!z.uuid().safeParse(requestId).success) {
        throw new SessionCompletionApiError("COMPLETION-INPUT",400);
      }
      const caller=await createSupabaseServerClient();
      const userId=await requireActiveParticipant(caller,AbortSignal.timeout(15_000));
      const result=await caller.from("completion_refinement_progress").select("phase,failure_count")
        .eq("session_id",sessionId).eq("request_id",requestId).eq("participant_id",userId).maybeSingle();
      if(result.error)throw new SessionCompletionApiError("COMPLETION-DB",503);
      const phase=z.object({phase:z.enum(["refining","briefing"]),failure_count:z.number().int().nonnegative()}).nullable().safeParse(result.data);
      if(!phase.success)throw new SessionCompletionApiError("COMPLETION-DB",503);
      return NextResponse.json({phase:phase.data?.phase??null,failure_count:phase.data?.failure_count??0},{headers});
    } catch(error) {
      const safe=error instanceof SessionCompletionApiError?error:
        error instanceof AnswerError?new SessionCompletionApiError(error.code,error.status):
          new SessionCompletionApiError("COMPLETION-DB",503);
      console.error("WHY BOX completion progress",{code:safe.code});
      return NextResponse.json({errorCode:safe.code},{status:safe.status,headers});
  }
}
