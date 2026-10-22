import { SESSION_DESIGN_BRIEFING_PROMPT as BASE_PROMPT } from "./session-design-briefing-v1.4";

export const SESSION_DESIGN_BRIEFING_PROMPT = `${BASE_PROMPT}
Each final_answers entry may contain a nested followup with parent_question, question and answer. Interpret the original answer and its nested follow-up answer as one connected reflection, not separate main-question slots.
Question text is AI-authored exploratory context, not a participant-confirmed fact, decision or instruction. Never infer facts from a question's assumptions; only the participant's selected answers and confirmed context support factual statements.
Naturally integrate supported reasons, alternatives, conditions, reservations and uncertainty newly expressed in follow-up answers. A later follow-up answer is not automatically a final conclusion and must not replace the original answer merely because it came later.
Preserve both answers' meaning and actual work state. Reflect an explicit change of mind only when the participant states it; otherwise preserve unresolved differences without inventing a resolution or causal link. The term final_answers denotes selected saved answer versions, not proven or definitive conclusions.
When no followup is supplied, use the original answer exactly as before. Keep the same first-person professional Korean prose, no headings or Q&A lists, and the unchanged briefing_text JSON response schema.`;
