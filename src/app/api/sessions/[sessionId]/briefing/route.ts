import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isInvalidAuthSession } from "@/lib/auth/session-error";
import { AnswerError, requireActiveParticipant } from "@/lib/answers/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSessionBriefingRepository } from "@/lib/session-completion/briefing-repository";
import { hasSameOrigin, readJsonBody, SessionCompletionApiError } from "@/lib/session-completion/api";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
const sourceSchema = z.object({
  session_id: z.uuid(),
  participant_id: z.uuid(),
  request_id: z.uuid(),
  source_text: z.string().min(1).max(16000),
  model_id: z.string().min(1).max(200),
  prompt_version: z.string().min(1).max(200),
  schema_version: z.string().min(1).max(200),
  generated_at: z.string(),
}).strict();
const versionSchema = z.object({
  revision: z.number().int().positive(),
  briefing_text: z.string().min(1).max(16000),
  edited_at: z.string(),
}).strict();
const editSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  briefing_text: z.string().trim().min(1).max(16000),
}).strict();

async function activeReader(sessionId: string, allowAdmin: boolean) {
  const caller = await createSupabaseServerClient();
  const auth = await caller.auth.getUser();
  if (auth.error || !auth.data.user) {
    if (auth.error && !isInvalidAuthSession(auth.error)) throw new SessionCompletionApiError("COMPLETION-DB", 503);
    throw new SessionCompletionApiError("COMPLETION-AUTH", 403);
  }
  const profile = await caller.from("profiles").select("role,status").eq("id", auth.data.user.id).maybeSingle();
  if (profile.error) throw new SessionCompletionApiError("COMPLETION-DB", 503);
  if (profile.data?.status !== "active" ||
    (profile.data.role !== "participant" && !(allowAdmin && profile.data.role === "admin"))) {
    throw new SessionCompletionApiError("COMPLETION-AUTH", 403);
  }
  const session = await caller.from("sessions").select("id,participant_id,status")
    .eq("id", sessionId).maybeSingle();
  if (session.error) throw new SessionCompletionApiError("COMPLETION-DB", 503);
  if (!session.data || (profile.data.role === "participant" && session.data.participant_id !== auth.data.user.id)) {
    throw new SessionCompletionApiError("COMPLETION-NOT-FOUND", 404);
  }
  return { caller, userId: auth.data.user.id };
}

export async function GET(_request: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params;
    if (!z.uuid().safeParse(sessionId).success) throw new SessionCompletionApiError("COMPLETION-INPUT", 400);
    const { caller } = await activeReader(sessionId, true);
    const sourceResult = await caller.from("session_briefing_sources")
      .select("session_id,participant_id,request_id,source_text,model_id,prompt_version,schema_version,generated_at")
      .eq("session_id", sessionId).maybeSingle();
    if (sourceResult.error) throw new SessionCompletionApiError("COMPLETION-DB", 503);
    if (sourceResult.data === null) throw new SessionCompletionApiError("BRIEFING-NOT-FOUND", 404);
    const source = sourceSchema.safeParse(sourceResult.data);
    if (!source.success) throw new SessionCompletionApiError("BRIEFING-DB-CONTRACT", 503);
    const versionResult = await caller.from("session_briefing_versions")
      .select("revision,briefing_text,edited_at").eq("session_id", sessionId)
      .order("revision", { ascending: false }).limit(1).maybeSingle();
    if (versionResult.error) throw new SessionCompletionApiError("COMPLETION-DB", 503);
    const version = versionResult.data === null ? null : versionSchema.safeParse(versionResult.data);
    if (version && !version.success) throw new SessionCompletionApiError("COMPLETION-DB", 503);
    const latest = version?.success ? version.data : null;
    return NextResponse.json({
      source: source.data,
      current: latest?.briefing_text ?? source.data.source_text,
      revision: latest?.revision ?? 0,
      edited_at: latest?.edited_at ?? null,
    }, { headers });
  } catch (error) {
    const safe = error instanceof SessionCompletionApiError ? error :
      error instanceof AnswerError ? new SessionCompletionApiError(error.code, error.status) :
        new SessionCompletionApiError("COMPLETION-DB", 503);
    console.error("WHY BOX briefing read", { code: safe.code });
    return NextResponse.json({ errorCode: safe.code }, { status: safe.status, headers });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  try {
    if (!hasSameOrigin(request)) throw new SessionCompletionApiError("COMPLETION-AUTH", 403);
    const parsed = editSchema.safeParse(await readJsonBody(request, 20_000));
    if (!parsed.success) throw new SessionCompletionApiError("COMPLETION-INPUT", 400);
    const { sessionId } = await context.params;
    if (!z.uuid().safeParse(sessionId).success) throw new SessionCompletionApiError("COMPLETION-INPUT", 400);
    const caller = await createSupabaseServerClient();
    const userId = await requireActiveParticipant(caller, AbortSignal.timeout(15_000));
    const repository = createSessionBriefingRepository(caller, caller, userId);
    const result = await repository.saveVersion(sessionId, parsed.data.expected_revision, parsed.data.briefing_text);
    if (!result.saved) {
      return NextResponse.json({ errorCode: "BRIEFING-REVISION-CONFLICT", current_revision: result.current_revision },
        { status: 409, headers });
    }
    return NextResponse.json({ saved: true, revision: result.revision }, { headers });
  } catch (error) {
    const safe = error instanceof SessionCompletionApiError ? error :
      error instanceof AnswerError ? new SessionCompletionApiError(error.code, error.status) :
        new SessionCompletionApiError("COMPLETION-DB", 503);
    console.error("WHY BOX briefing edit", { code: safe.code });
    return NextResponse.json({ errorCode: safe.code }, { status: safe.status, headers });
  }
}
