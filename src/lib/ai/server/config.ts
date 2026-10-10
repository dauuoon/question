import "server-only";
import { DraftError } from "../context-draft-contract";

export const DRAFT_TIMEOUT_MS = 60_000;
export const DRAFT_SIGNED_URL_SECONDS = 180;

export function contextDraftConfig(env: Record<string, string | undefined> = process.env) {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_CONTEXT_DRAFT_MODEL?.trim();
  if (env.OPENAI_CONTEXT_DRAFT_ENABLED !== "true" || !apiKey || !model) {
    throw new DraftError("DRAFT-CONFIG", 503);
  }
  return { apiKey, model };
}
