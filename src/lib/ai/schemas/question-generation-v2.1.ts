import { QUESTION_GENERATION_SCHEMA as BASE_SCHEMA } from "./question-generation-v2.0";
import { ANSWER_FORM_JSON_SCHEMA } from "../../answers/form";

const base = BASE_SCHEMA.schema.properties.questions;
export const QUESTION_GENERATION_SCHEMA = {
  ...BASE_SCHEMA,
  name: "why_box_question_generation_v2_1",
  schema: {
    ...BASE_SCHEMA.schema,
    properties: {
      questions: {
        ...base,
        items: {
          ...base.items,
          properties: { ...base.items.properties, answer_form: ANSWER_FORM_JSON_SCHEMA },
          required: [...base.items.required, "answer_form"],
        },
      },
    },
  },
} as const;
