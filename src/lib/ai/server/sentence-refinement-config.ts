import "server-only";
import { SentenceRefinementError } from "../sentence-refinement-contract";

export const SENTENCE_REFINEMENT_TIMEOUT_MS=60_000;

export function sentenceRefinementConfig(env:Record<string,string|undefined>=process.env) {
  const apiKey=env.OPENAI_API_KEY?.trim();
  const model=env.OPENAI_SENTENCE_REFINEMENT_MODEL?.trim();
  if(env.OPENAI_SENTENCE_REFINEMENT_ENABLED!=="true" || !apiKey || !model) {
    throw new SentenceRefinementError("REFINE-CONFIG");
  }
  return {apiKey,model};
}
