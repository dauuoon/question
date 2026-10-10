import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SentenceRefinementError } from "@/lib/ai/sentence-refinement-contract";

export const RESEARCHER_CALL_LIMIT = 3;
export const RESEARCHER_INPUT_LIMIT = 1200;
export const RESEARCHER_OUTPUT_LIMIT = 800;
const testURL = "https://njtgxnlxlhxpbiekbgmv.supabase.co";

export function assertResearcherEnvironment(env = process.env) {
  if (env.NODE_ENV === "production" || env.NEXT_PUBLIC_SUPABASE_URL !== testURL ||
      env.WHY_BOX_RESEARCHER_REFINEMENT !== "approved" ||
      env.OPENAI_SENTENCE_REFINEMENT_ENABLED !== "true" ||
      env.OPENAI_SENTENCE_REFINEMENT_MODEL !== "gpt-6-astra" ||
      env.OPENAI_CONTEXT_DRAFT_ENABLED !== "false" || env.OPENAI_CONTEXT_DRAFT_MODEL ||
      env.OPENAI_QUESTION_GENERATION_MODEL || env.OPENAI_QUESTION_REGENERATION_ENABLED !== "false" ||
      env.OPENAI_QUESTION_REGENERATION_MODEL || env.SESSION_BRIEFING_MOCK_ENABLED !== "true" ||
      !env.WHY_BOX_RESEARCHER_PARTICIPANT || !env.WHY_BOX_RESEARCHER_SESSION ||
      !env.WHY_BOX_RESEARCHER_BUDGET || !env.WHY_BOX_TEST_PROMPT_HASH) {
    throw new SentenceRefinementError("REFINE-CONFIG", 503);
  }
}

export function assertResearcherScope(userId: string, sessionId: string, env = process.env) {
  assertResearcherEnvironment(env);
  if (userId !== env.WHY_BOX_RESEARCHER_PARTICIPANT || sessionId !== env.WHY_BOX_RESEARCHER_SESSION) {
    throw new SentenceRefinementError("REFINE-AUTH", 403);
  }
}

export function researcherRefinementRemaining(budget: string) {
  return Array.from({ length: RESEARCHER_CALL_LIMIT }, (_, i) => i + 1)
    .filter(slot => !existsSync(join(budget, `call-${slot}`))).length;
}

function consumeBudget() {
  const budget = process.env.WHY_BOX_RESEARCHER_BUDGET!;
  const policy = JSON.parse(readFileSync(join(budget, "policy.json"), "utf8"));
  if (policy.callLimit !== RESEARCHER_CALL_LIMIT ||
      policy.participantId !== process.env.WHY_BOX_RESEARCHER_PARTICIPANT ||
      policy.sessionId !== process.env.WHY_BOX_RESEARCHER_SESSION ||
      policy.projectRef !== "njtgxnlxlhxpbiekbgmv") {
    throw new SentenceRefinementError("REFINE-CONFIG", 503);
  }
  for (let slot = 1; slot <= RESEARCHER_CALL_LIMIT; slot++) {
    const path = join(budget, `call-${slot}`);
    try {
      closeSync(openSync(path, "wx", 0o600));
      return path;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
  }
  throw new SentenceRefinementError("REFINE-BUDGET", 429);
}

export async function researcherRefinementFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  assertResearcherEnvironment();
  const url = input instanceof Request ? input.url : String(input);
  if (url !== "https://api.openai.com/v1/responses" || init?.method !== "POST" ||
      typeof init.body !== "string") throw new SentenceRefinementError("REFINE-INPUT", 400);
  const body = JSON.parse(init.body);
  const text = body.input?.[0]?.content?.[0]?.text;
  if (body.model !== "gpt-6-astra" || body.store !== false || body.stream !== false ||
      body.max_output_tokens !== RESEARCHER_OUTPUT_LIMIT || body.input?.length !== 1 ||
      body.input[0]?.role !== "user" || body.input[0]?.content?.length !== 1 ||
      body.input[0]?.content[0]?.type !== "input_text" ||
      typeof text !== "string" || !text.trim() || text.length > RESEARCHER_INPUT_LIMIT ||
      createHash("sha256").update(body.instructions ?? "").digest("hex") !== process.env.WHY_BOX_TEST_PROMPT_HASH) {
    throw new SentenceRefinementError("REFINE-INPUT", 400);
  }
  if (init.signal?.aborted) throw new SentenceRefinementError("REFINE-TIMEOUT", 504);
  const path = consumeBudget();
  // Markers are consumed before I/O and never reclaimed, even after crashes or timeouts.
  writeFileSync(`${path}.result.json`, JSON.stringify({ status: "started", calls: 1 }), { mode: 0o600 });
  try {
    const response = await globalThis.fetch(input, init);
    writeFileSync(`${path}.result.json`, JSON.stringify({
      status: response.ok ? "response_received" : "http_error", httpStatus: response.status, calls: 1,
    }), { mode: 0o600 });
    return response;
  } catch {
    writeFileSync(`${path}.result.json`, JSON.stringify({ status: "failed_or_timeout", calls: 1 }), { mode: 0o600 });
    throw new SentenceRefinementError("REFINE-API", 502);
  }
}
