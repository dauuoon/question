import { QUESTION_FOLLOWUP_PROMPT as previous } from "./question-followup-v1.9";
import { QUESTION_FUNCTION_UNDERSTANDING } from "./question-function-understanding";

export const QUESTION_FOLLOWUP_PROMPT_VERSION = "question-followup-v1.10";
export const QUESTION_FOLLOWUP_PROMPT = `${previous.replace("QUESTION FOLLOWUP PROMPT v1.9",
  "QUESTION FOLLOWUP PROMPT v1.10")}\n\n${QUESTION_FUNCTION_UNDERSTANDING}`;
