import { QUESTION_REGENERATION_PROMPT as previous } from "./question-regeneration-v1.9";
import { QUESTION_FUNCTION_UNDERSTANDING } from "./question-function-understanding";

export const QUESTION_REGENERATION_PROMPT_VERSION = "question-regeneration-v1.10";
export const QUESTION_REGENERATION_PROMPT = `${previous.replace("QUESTION REGENERATION PROMPT v1.9",
  "QUESTION REGENERATION PROMPT v1.10")}\n\n${QUESTION_FUNCTION_UNDERSTANDING}`;
