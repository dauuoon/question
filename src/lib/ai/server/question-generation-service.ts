import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isInvalidAuthSession } from "../../auth/session-error";
import { IMAGE_BUCKET } from "../../images/limits";
import { QUESTION_GENERATION_PROMPT_VERSION } from "../prompts/question-generation-v2.5";
import { QUESTION_GENERATION_SCHEMA } from "../schemas/question-generation-v2.0";
import {
  QuestionGenerationError, type QuestionGenerationRequest, type QuestionGenerationResult,
} from "../question-generation-contract";
import { attemptSchema, validateQuestionOutput, type GenerationAttempt, type QuestionCandidate } from "./question-generation-validation";
import {
  questionGenerationConfig, QUESTION_GENERATION_RECOVERY_MS, QUESTION_GENERATION_SIGNED_URL_SECONDS,
} from "./question-generation-config";
import { generateQuestions } from "./question-generation";

const beginSchema = z.object({
  attempt_id: z.uuid(), status: z.enum(["running", "completed", "failed"]), acquired: z.boolean(),
}).strict();
const commitSchema = z.object({
  attempt_id: z.uuid(), session_id: z.uuid(), status: z.literal("completed"), saved: z.boolean(),
}).strict();
export type BeginResult = z.infer<typeof beginSchema>;
export class QuestionStageError extends QuestionGenerationError {
  constructor(public readonly confirmedRejected: boolean) { super("QGEN-STAGE", 503); }
}
export type FailureCode = "QGEN-API" | "QGEN-TIMEOUT" | "QGEN-VALIDATION" | "QGEN-COMMIT" | "QGEN-CANCELLED";
export interface GenerationRepository {
  begin(input: QuestionGenerationRequest, signal: AbortSignal): Promise<BeginResult>;
  attempt(id: string, sessionId: string, signal: AbortSignal): Promise<GenerationAttempt>;
  images(attempt: GenerationAttempt, signal: AbortSignal): Promise<string[]>;
  stage(attempt: GenerationAttempt, candidates: QuestionCandidate[], metadata: { model: string; generatedAt: string }, signal: AbortSignal): Promise<void>;
  commit(attempt: GenerationAttempt, signal: AbortSignal): Promise<void>;
  completed(attempt: GenerationAttempt, signal: AbortSignal): Promise<string[]>;
  fail(attemptId: string, requestId: string, code: FailureCode, signal: AbortSignal): Promise<void>;
}

export function withinQuestionDeadline<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new QuestionGenerationError(
      signal.reason === "cancelled" ? "QGEN-CANCELLED" : "QGEN-TIMEOUT", signal.reason === "cancelled" ? 409 : 504,
    ));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

export async function authenticateQuestionParticipant(caller: SupabaseClient, signal: AbortSignal): Promise<string> {
  const auth = await withinQuestionDeadline(caller.auth.getUser(), signal);
  if (auth.error || !auth.data.user) {
    if (auth.error && !isInvalidAuthSession(auth.error)) throw new QuestionGenerationError("QGEN-DB", 503);
    throw new QuestionGenerationError("QGEN-AUTH", 403);
  }
  const profile = await caller.from("profiles").select("role,status")
    .eq("id", auth.data.user.id).abortSignal(signal).maybeSingle();
  if (profile.error) throw new QuestionGenerationError("QGEN-DB", 503);
  if (profile.data?.role !== "participant" || profile.data.status !== "active") {
    throw new QuestionGenerationError("QGEN-AUTH", 403);
  }
  return auth.data.user.id;
}

export function createGenerationRepository(caller: SupabaseClient, trusted: SupabaseClient, userId: string): GenerationRepository {
  return {
    async begin(input, signal) {
      const result = await caller.rpc("begin_question_generation", {
        p_session_id: input.session_id, p_request_id: input.request_id,
      }).abortSignal(signal);
      if (result.error) {
        if (result.error.code === "42501") throw new QuestionGenerationError("QGEN-AUTH", 403);
        if (result.error.code === "22023") throw new QuestionGenerationError("QGEN-INPUT", 400);
        if (result.error.code === "55000") throw new QuestionGenerationError("QGEN-BEGIN", 409);
        throw new QuestionGenerationError("QGEN-DB", 503);
      }
      const parsed = beginSchema.safeParse(result.data);
      if (!parsed.success) throw new QuestionGenerationError("QGEN-DB", 503);
      return parsed.data;
    },
    async attempt(id, sessionId, signal) {
      const result = await caller.from("question_generation_attempts")
        .select("id,session_id,request_id,status,input_snapshot,image_snapshot,requested_question_count,validated_candidates")
        .eq("id", id).eq("session_id", sessionId).abortSignal(signal).maybeSingle();
      const parsed = attemptSchema.safeParse(result.data);
      if (result.error || !parsed.success || parsed.data.id !== id || parsed.data.session_id !== sessionId) {
        throw new QuestionGenerationError("QGEN-DB", 503);
      }
      return parsed.data;
    },
    async images(attempt, signal) {
      const urls: string[] = [];
      for (const image of attempt.image_snapshot) {
        if (!image.storage_path.startsWith(`${userId}/${attempt.session_id}/`)) {
          throw new QuestionGenerationError("QGEN-IMAGE", 503);
        }
        const bucket = caller.storage.from(IMAGE_BUCKET);
        const slash = image.storage_path.lastIndexOf("/");
        const folder = image.storage_path.slice(0, slash);
        const name = image.storage_path.slice(slash + 1);
        const listed = await withinQuestionDeadline(bucket.list(folder, { search: name, limit: 100 }), signal);
        if (listed.error || !listed.data?.some((object) => object.name === name && object.id)) {
          throw new QuestionGenerationError("QGEN-IMAGE", 503);
        }
        const signed = await withinQuestionDeadline(bucket.createSignedUrl(image.storage_path, QUESTION_GENERATION_SIGNED_URL_SECONDS), signal);
        if (signed.error || !signed.data?.signedUrl) throw new QuestionGenerationError("QGEN-IMAGE", 503);
        urls.push(signed.data.signedUrl);
      }
      return urls;
    },
    async stage(attempt, candidates, metadata, signal) {
      const result = await trusted.rpc("stage_question_generation_candidates", {
        p_attempt_id: attempt.id, p_request_id: attempt.request_id, p_candidates: candidates,
        p_model_id: metadata.model, p_prompt_version: QUESTION_GENERATION_PROMPT_VERSION,
        p_schema_version: QUESTION_GENERATION_SCHEMA.name, p_framework_version: "v1.0", p_generated_at: metadata.generatedAt,
      }).abortSignal(signal);
      if (result.error || typeof result.data !== "boolean") {
        throw new QuestionStageError(!!result.error && /^[0-9A-Z]{5}$/.test(result.error.code));
      }
    },
    async commit(attempt, signal) {
      const result = await trusted.rpc("commit_question_generation", {
        p_attempt_id: attempt.id, p_request_id: attempt.request_id,
      }).abortSignal(signal);
      const parsed = commitSchema.safeParse(result.data);
      if (result.error || !parsed.success || parsed.data.attempt_id !== attempt.id || parsed.data.session_id !== attempt.session_id) {
        throw new QuestionGenerationError("QGEN-COMMIT", 503);
      }
    },
    async completed(attempt, signal) {
      const candidates = await caller.from("question_candidates").select("id,candidate_rank")
        .eq("attempt_id", attempt.id).eq("session_id", attempt.session_id)
        .order("candidate_rank").abortSignal(signal);
      const parsed = z.array(z.object({ id: z.uuid(), candidate_rank: z.number().int() }).strict()).length(5).safeParse(candidates.data);
      if (candidates.error || !parsed.success || parsed.data.some((c, i) => c.candidate_rank !== i + 1)) {
        throw new QuestionGenerationError("QGEN-DB", 503);
      }
      const questions = await caller.from("questions").select("id,source_candidate_id,slot_index")
        .eq("session_id", attempt.session_id).eq("question_kind", "original")
        .in("source_candidate_id", parsed.data.slice(0, attempt.requested_question_count).map((c) => c.id))
        .order("slot_index").abortSignal(signal);
      const rows = z.array(z.object({
        id: z.uuid(), source_candidate_id: z.uuid(), slot_index: z.number().int(),
      }).strict()).length(attempt.requested_question_count).safeParse(questions.data);
      if (questions.error || !rows.success || new Set(rows.data.map((q) => q.id)).size !== rows.data.length ||
        rows.data.some((q, i) => q.slot_index !== i + 1 || q.source_candidate_id !== parsed.data[i].id)) {
        throw new QuestionGenerationError("QGEN-DB", 503);
      }
      return rows.data.map((q) => q.id);
    },
    async fail(attemptId, requestId, code, signal) {
      const result = await trusted.rpc("fail_question_generation", {
        p_attempt_id: attemptId, p_request_id: requestId, p_failure_code: code,
      }).abortSignal(signal);
      if (result.error || typeof result.data !== "boolean") throw new QuestionGenerationError("QGEN-RECOVERY", 503);
    },
  };
}

type Generator = typeof generateQuestions;
export async function runQuestionGeneration(
  repository: GenerationRepository, input: QuestionGenerationRequest, signal: AbortSignal,
  dependencies: { config?: typeof questionGenerationConfig; generate?: Generator } = {},
): Promise<QuestionGenerationResult> {
  let begin: BeginResult | undefined;
  let beginDispatched = false;
  let attempt: GenerationAttempt | undefined;
  let staging = false;
  let staged = false;
  const run = <T>(operation: () => PromiseLike<T>) => {
    if (signal.aborted) throw new QuestionGenerationError(
      signal.reason === "cancelled" ? "QGEN-CANCELLED" : "QGEN-TIMEOUT", signal.reason === "cancelled" ? 409 : 504,
    );
    return withinQuestionDeadline(operation(), signal);
  };
  const completed = async (value: GenerationAttempt): Promise<QuestionGenerationResult> => ({
    request_id: input.request_id, attempt_id: value.id, status: "completed",
    question_ids: await run(() => repository.completed(value, signal)),
  });
  try {
    begin = await run(() => {
      beginDispatched = true;
      return repository.begin(input, signal);
    });
    if (begin.status === "failed") throw new QuestionGenerationError("QGEN-FAILED", 409);
    const acquired = begin;
    attempt = await run(() => repository.attempt(acquired.attempt_id, input.session_id, signal));
    if (begin.acquired && attempt.request_id !== input.request_id) throw new QuestionGenerationError("QGEN-DB", 503);
    if (attempt.status === "failed") throw new QuestionGenerationError("QGEN-FAILED", 409);
    if (attempt.status === "completed") return await completed(attempt);
    if (attempt.validated_candidates !== null) {
      staged = true;
      const current = attempt;
      await run(() => repository.commit(current, signal));
      return await completed(attempt);
    }
    if (!begin.acquired) return {
      request_id: input.request_id, attempt_id: attempt.id, status: "running", retry_same_request: true,
    };
    const config = (dependencies.config ?? questionGenerationConfig)();
    const current = attempt;
    const urls = await run(() => repository.images(current, signal));
    const generated = await run(() => (dependencies.generate ?? generateQuestions)(config, current, urls, signal));
    const candidates = validateQuestionOutput(generated.output, attempt);
    staging = true;
    await run(() => repository.stage(current, candidates, generated, signal));
    staged = true;
    await run(() => repository.commit(current, signal));
    return await completed(attempt);
  } catch (error) {
    if (!begin && beginDispatched && !(error instanceof QuestionGenerationError &&
      ["QGEN-AUTH", "QGEN-INPUT", "QGEN-BEGIN"].includes(error.code))) {
      // Without the begin response we cannot prove this worker owns the execution right.
      throw new QuestionGenerationError("QGEN-RECOVERY", 503);
    }
    const safe = signal.aborted ? new QuestionGenerationError(
      signal.reason === "cancelled" ? "QGEN-CANCELLED" : "QGEN-TIMEOUT", signal.reason === "cancelled" ? 409 : 504,
    ) : error instanceof QuestionGenerationError ? error : new QuestionGenerationError("QGEN-DB", 503);
    if (begin?.acquired && !staged) {
      // A stage response can be lost after the DB commit. Re-read before releasing the lock.
      const cleanup = new AbortController();
      const timer = setTimeout(() => cleanup.abort(), QUESTION_GENERATION_RECOVERY_MS);
      try {
        if (staging) {
          const current = await withinQuestionDeadline(repository.attempt(begin.attempt_id, input.session_id, cleanup.signal), cleanup.signal);
          staged = current.validated_candidates !== null || current.status === "completed";
          if (!staged && !(error instanceof QuestionStageError && error.confirmedRejected)) {
            throw new QuestionGenerationError("QGEN-RECOVERY", 503);
          }
        }
        if (!staged) {
          const code: FailureCode = safe.code === "QGEN-TIMEOUT" ? "QGEN-TIMEOUT" :
            safe.code === "QGEN-CANCELLED" ? "QGEN-CANCELLED" :
              ["QGEN-VALIDATION", "QGEN-CONTEXT", "QGEN-REFUSAL", "QGEN-INCOMPLETE"].includes(safe.code) ? "QGEN-VALIDATION" :
                safe.code === "QGEN-STAGE" ? "QGEN-COMMIT" : "QGEN-API";
          await withinQuestionDeadline(repository.fail(begin.attempt_id, attempt?.request_id ?? input.request_id, code, cleanup.signal), cleanup.signal);
        }
      } catch {
        // Do not guess whether an ambiguous stage succeeded or silently report cleanup success.
        throw new QuestionGenerationError("QGEN-RECOVERY", 503);
      } finally { clearTimeout(timer); }
    }
    throw safe;
  }
}
