import "server-only";
import { QuestionGenerationError } from "../question-generation-contract";

export const QUESTION_GENERATION_TIMEOUT_MS = 60_000;
export const QUESTION_GENERATION_RECOVERY_MS = 8_000;
export const QUESTION_GENERATION_SIGNED_URL_SECONDS = 180;

export function questionGenerationConfig(env: Record<string, string | undefined> = process.env) {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_QUESTION_GENERATION_MODEL?.trim();
  if (!apiKey || !model) throw new QuestionGenerationError("QGEN-CONFIG", 503);
  return { apiKey, model };
}
