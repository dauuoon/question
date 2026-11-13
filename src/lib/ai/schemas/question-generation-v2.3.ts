import { QUESTION_GENERATION_SCHEMA as BASE } from "./question-generation-v2.1";
import { ANSWER_FORM_WITH_SINGLE_CHOICE_JSON_SCHEMA } from "../../answers/form";

const questions = BASE.schema.properties.questions;
export const QUESTION_GENERATION_SCHEMA = {
  ...BASE,
  name: "why_box_question_generation_v2_3",
  schema: {
    ...BASE.schema,
    properties: {
      questions: {
        ...questions,
        items: {
          ...questions.items,
          properties: { ...questions.items.properties, answer_form: ANSWER_FORM_WITH_SINGLE_CHOICE_JSON_SCHEMA },
        },
      },
    },
  },
} as const;
