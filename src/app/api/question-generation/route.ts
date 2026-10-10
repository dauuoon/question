import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  questionGenerationRequestSchema, questionGenerationErrorMessages, QuestionGenerationError,
} from "@/lib/ai/question-generation-contract";
import { QUESTION_GENERATION_TIMEOUT_MS } from "@/lib/ai/server/question-generation-config";
import {
  authenticateQuestionParticipant, createGenerationRepository, runQuestionGeneration, withinQuestionDeadline,
} from "@/lib/ai/server/question-generation-service";
import { readGenerationView } from "@/lib/question-generation/read";

export const runtime = "nodejs";
export const maxDuration = 80;
const headers = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), 10_000);
  try {
    const caller = await createSupabaseServerClient();
    const userId = await withinQuestionDeadline(authenticateQuestionParticipant(caller, controller.signal), controller.signal);
    const view = await withinQuestionDeadline(
      readGenerationView(caller, userId, request.nextUrl.searchParams.get("session_id") ?? ""), controller.signal,
    );
    return NextResponse.json(view, { headers });
  } catch (error) {
    const safe = error instanceof QuestionGenerationError ? error : new QuestionGenerationError("QGEN-DB", 503);
    console.error("WHY BOX question generation", { code: safe.code, phase: "read" });
    return NextResponse.json({ errorCode: safe.code, message: questionGenerationErrorMessages[safe.code] },
      { status: safe.status, headers });
  } finally { clearTimeout(timer); }
}

export async function POST(request: NextRequest) {
  let requestId: string | undefined;
  let phase = "origin";
  const controller = new AbortController();
  const cancel = () => controller.abort("cancelled");
  const timer = setTimeout(() => controller.abort("timeout"), QUESTION_GENERATION_TIMEOUT_MS);
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  try {
    const protocol = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.slice(0, -1);
    const host = request.headers.get("host");
    if (!host || request.headers.get("origin") !== `${protocol}://${host}`) throw new QuestionGenerationError("QGEN-AUTH", 403);
    phase = "input";
    const reader = request.body?.getReader();
    if (!reader) throw new QuestionGenerationError("QGEN-INPUT", 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await withinQuestionDeadline(reader.read(), controller.signal);
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 4096) { await reader.cancel(); throw new QuestionGenerationError("QGEN-INPUT", 413); }
      chunks.push(chunk.value);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new QuestionGenerationError("QGEN-INPUT", 400); }
    const parsed = questionGenerationRequestSchema.safeParse(body);
    if (!parsed.success) throw new QuestionGenerationError("QGEN-INPUT", 400);
    requestId = parsed.data.request_id;
    phase = "auth";
    const caller = await createSupabaseServerClient();
    const userId = await withinQuestionDeadline(authenticateQuestionParticipant(caller, controller.signal), controller.signal);
    phase = "generation";
    const repository = createGenerationRepository(caller, createSupabaseAdminClient(), userId);
    const result = await runQuestionGeneration(repository, parsed.data, controller.signal);
    return NextResponse.json(result, { status: result.status === "running" ? 202 : 200, headers });
  } catch (error) {
    const safe = error instanceof QuestionGenerationError ? error : new QuestionGenerationError("QGEN-DB", 503);
    console.error("WHY BOX question generation", { code: safe.code, phase, requestId });
    return NextResponse.json({
      errorCode: safe.code, message: questionGenerationErrorMessages[safe.code], request_id: requestId,
    }, { status: safe.status, headers: { ...headers, ...(safe.status === 429 ? { "Retry-After": "60" } : {}) } });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
  }
}
