import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  briefingFinishSchema,
  briefingRequestSchema,
  briefingVersionSaveSchema,
} from "./briefing-contract";
import type { SessionBriefingRepository } from "../ai/server/session-briefing-service";

export class SessionBriefingRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SessionBriefingRepositoryError";
  }
}

export function createSessionBriefingRepository(
  caller: SupabaseClient,
  trusted: SupabaseClient,
  participantId: string,
): SessionBriefingRepository & {
  saveVersion(sessionId: string, expectedRevision: number, text: string): Promise<z.infer<typeof briefingVersionSaveSchema>>;
  claimDiaryPrompt(sessionId: string): Promise<boolean>;
} {
  async function call(client: SupabaseClient, name: string, parameters: Record<string, unknown>) {
    const result = await client.rpc(name, parameters).abortSignal(AbortSignal.timeout(10_000));
    if (result.error) throw new SessionBriefingRepositoryError(result.error.code);
    return result.data as unknown;
  }

  async function checked<T>(schema: z.ZodType<T>, client: SupabaseClient, name: string,
    parameters: Record<string, unknown>): Promise<T> {
    const parsed = schema.safeParse(await call(client, name, parameters));
    if (!parsed.success) throw new SessionBriefingRepositoryError("BRIEFING-DB-CONTRACT");
    return parsed.data;
  }

  async function readRequest(sessionId: string, requestId: string) {
    const result = await checked(
      briefingRequestSchema.nullable(), caller, "read_session_briefing_request", {
        p_session_id: sessionId,
        p_request_id: requestId,
      },
    );
    if (result === null) throw new SessionBriefingRepositoryError("BRIEFING-NOT-FOUND");
    return result;
  }

  return {
    begin: (input) => checked(briefingRequestSchema, caller, "begin_session_completion", {
      p_session_id: input.session_id,
      p_request_id: input.request_id,
      p_retry_of_request_id: input.retry_of_request_id,
    }),
    read: readRequest,
    dispatch: (sessionId, requestId) => checked(z.boolean(), trusted, "authorize_session_briefing_dispatch", {
      p_session_id: sessionId,
      p_request_id: requestId,
      p_participant_id: participantId,
    }),
    complete: (input) => checked(briefingFinishSchema, trusted, "finish_session_briefing", {
      p_session_id: input.session_id,
      p_request_id: input.request_id,
      p_participant_id: participantId,
      p_source_text: input.briefing_text,
      p_model_id: input.model_id,
      p_prompt_version: input.prompt_version,
      p_schema_version: input.schema_version,
    }),
    fail: (input) => checked(z.boolean(), trusted, "fail_session_briefing", {
      p_session_id: input.session_id,
      p_request_id: input.request_id,
      p_participant_id: participantId,
      p_failure_code: input.failure_code,
      p_outcome_unknown: input.outcome_unknown,
    }),
    saveVersion: (sessionId, expectedRevision, text) => checked(
      briefingVersionSaveSchema, caller, "save_session_briefing_version", {
        p_session_id: sessionId,
        p_expected_revision: expectedRevision,
        p_briefing_text: text,
      }),
    claimDiaryPrompt: (sessionId) => checked(z.boolean(), caller, "claim_session_diary_prompt", {
      p_session_id: sessionId,
    }),
  };
}
