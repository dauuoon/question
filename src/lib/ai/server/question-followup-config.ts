import "server-only";
import { QuestionFollowupError } from "../question-followup-contract";

export const QUESTION_FOLLOWUP_TIMEOUT_MS = 60_000;

export function questionFollowupConfig(env: Record<string, string | undefined> = process.env) {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_QUESTION_FOLLOWUP_MODEL?.trim() || env.OPENAI_QUESTION_GENERATION_MODEL?.trim();
  if (env.OPENAI_QUESTION_FOLLOWUP_ENABLED !== "true" || !apiKey || !model) {
    throw new QuestionFollowupError("FOLLOWUP-CONFIG");
  }
  return { apiKey, model };
}
