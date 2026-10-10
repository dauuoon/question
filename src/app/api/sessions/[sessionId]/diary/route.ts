import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveParticipant, AnswerError } from "@/lib/answers/server";
import { hasSameOrigin, readJsonBody, SessionCompletionApiError } from "@/lib/session-completion/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { diarySubmissionSchema } from "@/lib/diaries/contract";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
const submissionRequestSchema = z.object({ action: z.literal("submit"), diary: diarySubmissionSchema }).strict();
const promptRequestSchema = z.object({ action: z.literal("claim_prompt") }).strict();

function apiError(error: unknown) {
  return error instanceof SessionCompletionApiError ? error :
    error instanceof AnswerError ? new SessionCompletionApiError(error.code, error.status) :
      new SessionCompletionApiError("DIARY-DB", 503);
}

export async function GET(_request: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params;
    if (!z.uuid().safeParse(sessionId).success) throw new SessionCompletionApiError("DIARY-INPUT", 400);
    const supabase = await createSupabaseServerClient();
    const participantId = await requireActiveParticipant(supabase, AbortSignal.timeout(15_000));
    const { data, error } = await supabase.from("diaries")
      .select("experience_choices_json,feeling_choices_json,free_text,status,submitted_at,updated_at")
      .eq("session_id", sessionId).eq("participant_id", participantId).maybeSingle();
    if (error) throw new SessionCompletionApiError("DIARY-DB", 503);
    if (!data) return NextResponse.json({ diary: null }, { headers });
    const parsed = z.object({
      experience_choices_json: z.array(z.string()),
      feeling_choices_json: z.array(z.string()),
      free_text: z.string().nullable(),
      status: z.enum(["not_started", "submitted"]),
      submitted_at: z.string().nullable(),
      updated_at: z.string(),
    }).strict().safeParse(data);
    if (!parsed.success) throw new SessionCompletionApiError("DIARY-DB", 503);
    const submitted = parsed.data.status === "submitted";
    const diary = diarySubmissionSchema.safeParse({
      experience_choices: parsed.data.experience_choices_json,
      feeling_choices: parsed.data.feeling_choices_json,
      free_text: parsed.data.free_text,
    });
    if (submitted && !diary.success) throw new SessionCompletionApiError("DIARY-DB", 503);
    return NextResponse.json({
      diary: {
        status: parsed.data.status,
        submitted_at: parsed.data.submitted_at,
        updated_at: parsed.data.updated_at,
        ...(diary.success ? diary.data : {
          experience_choices: [], feeling_choices: [], free_text: parsed.data.free_text,
        }),
      },
    }, { headers });
  } catch (error) {
    const safe = apiError(error);
    console.error("WHY BOX diary read", { code: safe.code });
    return NextResponse.json({ errorCode: safe.code }, { status: safe.status, headers });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  try {
    if (!hasSameOrigin(request)) throw new SessionCompletionApiError("DIARY-AUTH", 403);
    const { sessionId } = await context.params;
    if (!z.uuid().safeParse(sessionId).success) throw new SessionCompletionApiError("DIARY-INPUT", 400);
    const body = await readJsonBody(request, 30_000);
    const promptRequest = promptRequestSchema.safeParse(body);
    const submission = submissionRequestSchema.safeParse(body);
    if (!promptRequest.success && !submission.success) throw new SessionCompletionApiError("DIARY-INPUT", 400);

    const supabase = await createSupabaseServerClient();
    const participantId = await requireActiveParticipant(supabase, AbortSignal.timeout(15_000));
    const session = await supabase.from("sessions").select("id")
      .eq("id", sessionId).eq("participant_id", participantId).eq("status", "completed").maybeSingle();
    if (session.error) throw new SessionCompletionApiError("DIARY-DB", 503);
    if (!session.data) throw new SessionCompletionApiError("COMPLETION-NOT-FOUND", 404);

    if (promptRequest.success) {
      const claim = await supabase.rpc("claim_session_diary_prompt", { p_session_id: sessionId })
        .abortSignal(AbortSignal.timeout(10_000));
      if (claim.error || typeof claim.data !== "boolean") throw new SessionCompletionApiError("DIARY-DB", 503);
      return NextResponse.json({ claimed: claim.data }, { headers });
    }
    if (!submission.success) throw new SessionCompletionApiError("DIARY-INPUT", 400);
    const { data: existing, error: existingError } = await supabase.from("diaries")
      .select("id,status").eq("session_id", sessionId).maybeSingle();
    if (existingError) throw new SessionCompletionApiError("DIARY-DB", 503);
    if (existing?.status === "submitted") throw new SessionCompletionApiError("DIARY-SUBMITTED", 409);
    const { diary } = submission.data;
    const submittedAt = new Date().toISOString();
    const diaryValues = {
      experience_choices_json: diary.experience_choices,
      feeling_choices_json: diary.feeling_choices,
      free_text: diary.free_text?.trim() || null,
      status: "submitted" as const,
      submitted_at: submittedAt,
    };
    const { data, error } = existing ?
      await supabase.from("diaries").update(diaryValues)
        .eq("session_id", sessionId).eq("participant_id", participantId).eq("status", "not_started")
        .select("submitted_at").maybeSingle() :
      await supabase.from("diaries").insert({
        ...diaryValues, session_id: sessionId, participant_id: participantId,
      }).select("submitted_at").single();
    if (error || !data) {
      if (error?.code === "23505" || existing) throw new SessionCompletionApiError("DIARY-SUBMITTED", 409);
      throw new SessionCompletionApiError("DIARY-DB", 503);
    }
    return NextResponse.json({ submitted: true, submitted_at: data.submitted_at }, { headers });
  } catch (error) {
    const safe = apiError(error);
    console.error("WHY BOX diary save", { code: safe.code });
    return NextResponse.json({ errorCode: safe.code }, { status: safe.status, headers });
  }
}
