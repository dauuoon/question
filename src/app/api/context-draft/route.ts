import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isInvalidAuthSession } from "@/lib/auth/session-error";
import { draftRequestSchema, DraftError, draftErrorMessages } from "@/lib/ai/context-draft-contract";
import { contextDraftConfig, DRAFT_TIMEOUT_MS } from "@/lib/ai/server/config";
import { generateContextDraft } from "@/lib/ai/server/context-draft";
import { prepareDraft, verifyDraftSession } from "@/lib/ai/server/context-draft-service";

export const runtime = "nodejs";
export const maxDuration = 70;
const headers = { "Cache-Control": "no-store" };

function withinDeadline<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new DraftError("DRAFT-TIMEOUT", 504));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

export async function POST(request: NextRequest) {
  let requestId: string | undefined;
  let phase = "origin";
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, DRAFT_TIMEOUT_MS);
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  try {
    const protocol = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.slice(0, -1);
    if (!request.headers.get("host") || request.headers.get("origin") !== `${protocol}://${request.headers.get("host")}`) {
      throw new DraftError("DRAFT-AUTH", 403);
    }
    phase = "input";
    const reader = request.body?.getReader();
    if (!reader) throw new DraftError("DRAFT-INPUT", 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await withinDeadline(reader.read(), controller.signal);
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 16_384) { await reader.cancel(); throw new DraftError("DRAFT-INPUT", 413); }
      chunks.push(chunk.value);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new DraftError("DRAFT-INPUT", 400); }
    const parsed = draftRequestSchema.safeParse(body);
    if (!parsed.success) throw new DraftError("DRAFT-INPUT", 400);
    const input = parsed.data;
    requestId = input.request_id;
    phase = "auth";
    const supabase = await createSupabaseServerClient();
    const auth = await withinDeadline(supabase.auth.getUser(), controller.signal);
    if (auth.error || !auth.data.user) {
      if (auth.error && !isInvalidAuthSession(auth.error)) throw new DraftError("DRAFT-DB", 503);
      throw new DraftError("DRAFT-AUTH", 403);
    }
    const userId = auth.data.user.id;
    const profile = await withinDeadline(supabase.from("profiles").select("role, status")
      .eq("id", userId).maybeSingle(), controller.signal);
    if (profile.error) throw new DraftError("DRAFT-DB", 503);
    if (profile.data?.role !== "participant" || profile.data.status !== "active") throw new DraftError("DRAFT-AUTH", 403);
    phase = "config";
    const config = contextDraftConfig();
    phase = "prepare";
    const urls = await withinDeadline(prepareDraft(supabase, userId, input), controller.signal);
    if (!urls) return NextResponse.json({ request_id: requestId, skipped: true }, { headers });
    if (controller.signal.aborted) throw new DraftError("DRAFT-TIMEOUT", 504);
    phase = "generate";
    const text = await withinDeadline(generateContextDraft(config, input.input, urls, controller.signal), controller.signal);
    phase = "recheck";
    await withinDeadline(verifyDraftSession(supabase, input.session_id, userId), controller.signal);
    const currentProfile = await withinDeadline(supabase.from("profiles").select("role, status")
      .eq("id", userId).maybeSingle(), controller.signal);
    if (currentProfile.error) throw new DraftError("DRAFT-DB", 503);
    if (currentProfile.data?.role !== "participant" || currentProfile.data.status !== "active") throw new DraftError("DRAFT-AUTH", 403);
    if (controller.signal.aborted) throw new DraftError("DRAFT-TIMEOUT", 504);
    return NextResponse.json({ request_id: requestId, draft_text: text }, { headers });
  } catch (error) {
    const safe = error instanceof DraftError ? error : new DraftError("DRAFT-API");
    console.error("WHY BOX context draft", { code: safe.code, phase, requestId });
    return NextResponse.json({ errorCode: safe.code, message: draftErrorMessages[safe.code], request_id: requestId },
      { status: safe.status, headers: { ...headers, ...(safe.status === 429 ? { "Retry-After": "60" } : {}) } });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
  }
}
