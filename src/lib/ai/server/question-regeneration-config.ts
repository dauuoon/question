import "server-only";
import { QuestionActionError } from "../../question-generation/actions-contract";

export const QUESTION_REGENERATION_TIMEOUT_MS=60_000;
export function questionRegenerationEnabled(env:Record<string,string|undefined>=process.env) {
  return env.OPENAI_QUESTION_REGENERATION_ENABLED==="true";
}
export function questionRegenerationConfig(env:Record<string,string|undefined>=process.env) {
  const apiKey=env.OPENAI_API_KEY?.trim(),model=env.OPENAI_QUESTION_REGENERATION_MODEL?.trim();
  if(!questionRegenerationEnabled(env)||!apiKey||!model)throw new QuestionActionError("QR-CONFIG",503);
  return {apiKey,model};
}
