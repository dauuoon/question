import { SESSION_DESIGN_BRIEFING_PROMPT as PREVIOUS_PROMPT } from "./session-design-briefing-v1.5";

export const SESSION_DESIGN_BRIEFING_PROMPT = `${PREVIOUS_PROMPT}

Each final_answers entry includes its question as context, including for free-text and numbered answers. Use it only to interpret what the participant's answer refers to; it is not evidence that the question's assumptions are true.
Write connected prose instead of repeating phrases such as "제 답변은 ...입니다" or listing quotations. When a short answer is ambiguous even with the question, preserve the ambiguity rather than inventing details.
For a selected option, describe what was selected in the context of that specific question. Do not infer a reason, intention, importance or conclusion from the selection alone.
Distinguish a predicted user response or possibility from a confirmed design decision, and do not invent causal connections between different answers.`.trim();
