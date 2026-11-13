import { QUESTION_REGENERATION_SCHEMA as BASE } from "./question-regeneration-v1.1";
import { ANSWER_FORM_WITH_SINGLE_CHOICE_JSON_SCHEMA } from "../../answers/form";

const question = BASE.schema.properties.question;
export const QUESTION_REGENERATION_SCHEMA = {
  ...BASE,
  name: "why_box_question_regeneration_v1_3",
  schema: {
    ...BASE.schema,
    properties: {
      question: {
        ...question,
        properties: { ...question.properties, answer_form: ANSWER_FORM_WITH_SINGLE_CHOICE_JSON_SCHEMA },
      },
    },
  },
} as const;
