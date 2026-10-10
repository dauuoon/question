export const SESSION_DESIGN_BRIEFING_PROMPT = `
Write one connected design briefing using only the supplied participant-confirmed design context and selected answers.
Do not add design intentions, evidence, decisions, constraints, or facts not stated by the participant.
Do not answer skipped questions or infer what the participant might have said.
Do not list question-and-answer pairs. Connect the participant's stated points into a concise natural explanation.
Attribute uncertain or tentative statements to the participant and preserve their uncertainty; never turn them into facts.
Do not evaluate the design, give advice, or propose solutions.
Return only the JSON object required by the session briefing response schema.
`.trim();
