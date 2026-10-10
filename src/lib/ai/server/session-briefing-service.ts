import "server-only";
import { z } from "zod";
import {
  briefingInputSchema,
  briefingResultSchema,
  SESSION_BRIEFING_PROMPT_VERSION,
  SESSION_BRIEFING_SCHEMA_VERSION,
  type BriefingInput,
  type BriefingRequest,
} from "@/lib/session-completion/briefing-contract";

export class SessionBriefingProviderError extends Error {
  constructor(readonly safeCode: string, readonly outcomeUnknown: boolean) {
    super(safeCode);
    this.name = "SessionBriefingProviderError";
  }
}

export interface SessionBriefingRepository {
  begin(input: {
    session_id: string;
    request_id: string;
    retry_of_request_id: string | null;
  }): Promise<BriefingRequest>;
  read(sessionId: string, requestId: string): Promise<BriefingRequest>;
  dispatch(sessionId: string, requestId: string): Promise<boolean>;
  complete(input: {
    session_id: string;
    request_id: string;
    briefing_text: string;
    model_id: string;
    prompt_version: string;
    schema_version: string;
  }): Promise<unknown>;
  fail(input: {
    session_id: string;
    request_id: string;
    failure_code: string;
    outcome_unknown: boolean;
  }): Promise<boolean>;
}

export interface SessionBriefingProvider {
  generate(input: BriefingInput): Promise<{ response: unknown; model_id: string }>;
}

const providerResponseSchema = z.object({
  response: z.unknown(),
  model_id: z.string().trim().min(1).max(200),
}).strict();

export async function runSessionBriefing(
  repository: SessionBriefingRepository,
  provider: SessionBriefingProvider,
  request: { session_id: string; request_id: string; retry_of_request_id?: string | null },
): Promise<BriefingRequest> {
  const identity = {
    session_id: request.session_id,
    request_id: request.request_id,
  };
  const begun = await repository.begin({
    ...identity,
    retry_of_request_id: request.retry_of_request_id ?? null,
  });
  if (begun.state !== "ready" || !begun.accepted) return begun;

  const input = briefingInputSchema.safeParse(begun.input_snapshot);
  if (!input.success) {
    await repository.fail({ ...identity, failure_code: "BRIEFING-INPUT", outcome_unknown: false });
    return repository.read(identity.session_id, identity.request_id);
  }

  if (!await repository.dispatch(identity.session_id, identity.request_id)) {
    return repository.read(identity.session_id, identity.request_id);
  }

  let generated: { response: unknown; model_id: string };
  try {
    generated = await provider.generate(input.data);
  } catch (error) {
    const providerError = error instanceof SessionBriefingProviderError ? error : null;
    await repository.fail({
      ...identity,
      failure_code: providerError?.safeCode ?? "BRIEFING-PROVIDER",
      outcome_unknown: providerError?.outcomeUnknown ?? true,
    });
    return repository.read(identity.session_id, identity.request_id);
  }

  const providerResponse = providerResponseSchema.safeParse(generated);
  if (!providerResponse.success) {
    await repository.fail({ ...identity, failure_code: "BRIEFING-PROVENANCE", outcome_unknown: false });
    return repository.read(identity.session_id, identity.request_id);
  }

  const result = briefingResultSchema.safeParse(providerResponse.data.response);
  if (!result.success) {
    await repository.fail({ ...identity, failure_code: "BRIEFING-VALIDATION", outcome_unknown: false });
    return repository.read(identity.session_id, identity.request_id);
  }

  try {
    await repository.complete({
      ...identity,
      briefing_text: result.data.briefing_text,
      model_id: providerResponse.data.model_id,
      prompt_version: SESSION_BRIEFING_PROMPT_VERSION,
      schema_version: SESSION_BRIEFING_SCHEMA_VERSION,
    });
  } catch {
    await repository.fail({
      ...identity,
      failure_code: "BRIEFING-COMMIT-UNKNOWN",
      outcome_unknown: true,
    });
    return repository.read(identity.session_id, identity.request_id);
  }
  return repository.read(identity.session_id, identity.request_id);
}
