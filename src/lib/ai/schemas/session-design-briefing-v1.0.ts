export const SESSION_DESIGN_BRIEFING_SCHEMA = {
  name: "why_box_session_design_briefing_v1_0",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["briefing_text"],
    properties: {
      briefing_text: { type: "string", minLength: 1, maxLength: 16000 },
    },
  },
} as const;
