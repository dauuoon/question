import { z } from "zod";

const labelSchema = z.string().trim().min(1).max(100).refine(text => !text.includes("\0"));
const itemFormSchema = z.object({
  kind: z.enum(["numbered", "sections"]),
  title: labelSchema,
  labels: z.array(labelSchema).min(2).max(6),
}).strict().refine(form => new Set(form.labels).size === form.labels.length);
const choiceFormSchema = z.object({
  kind: z.literal("choice"),
  title: labelSchema,
  labels: z.array(labelSchema).min(4).max(6),
  max_selections: z.number().int().min(1).max(5),
  explanation_prompt: labelSchema,
}).strict().refine(form => new Set(form.labels).size === form.labels.length &&
  form.labels.at(-2) === "직접 입력" && form.labels.at(-1) === "짧은 설명" &&
  form.max_selections <= form.labels.length - 1);
export const answerFormSchema = z.union([itemFormSchema, choiceFormSchema]);
export type AnswerForm = z.infer<typeof answerFormSchema>;
export const answerFieldsSchema = z.array(z.string().max(20_000)).min(2).max(6);

export const ANSWER_FORM_JSON_SCHEMA = {
  anyOf: [
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["numbered", "sections"] },
        title: { type: "string" },
        labels: { type: "array", minItems: 2, maxItems: 6, items: { type: "string" } },
      },
      required: ["kind", "title", "labels"],
      additionalProperties: false,
    },
    { type: "null" },
  ],
} as const;

export const ANSWER_FORM_WITH_CHOICE_JSON_SCHEMA = {
  anyOf: [
    ANSWER_FORM_JSON_SCHEMA.anyOf[0],
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["choice"] },
        title: { type: "string" },
        labels: { type: "array", minItems: 4, maxItems: 6, items: { type: "string" } },
        max_selections: { type: "integer", minimum: 1, maximum: 5 },
        explanation_prompt: { type: "string" },
      },
      required: ["kind", "title", "labels", "max_selections", "explanation_prompt"],
      additionalProperties: false,
    },
    { type: "null" },
  ],
} as const;

export const ANSWER_FORM_WITH_SINGLE_CHOICE_JSON_SCHEMA = {
  ...ANSWER_FORM_WITH_CHOICE_JSON_SCHEMA,
  anyOf: [
    ANSWER_FORM_WITH_CHOICE_JSON_SCHEMA.anyOf[0],
    {
      ...ANSWER_FORM_WITH_CHOICE_JSON_SCHEMA.anyOf[1],
      properties: {
        ...ANSWER_FORM_WITH_CHOICE_JSON_SCHEMA.anyOf[1].properties,
        max_selections: { type: "integer", minimum: 1, maximum: 1 },
      },
    },
    ANSWER_FORM_WITH_CHOICE_JSON_SCHEMA.anyOf[2],
  ],
} as const;

export function answerFieldsText(fields: string[]): string {
  return fields.filter(text => text.trim().length > 0).join("\n\n");
}

export function answerFieldsMatchForm(form: AnswerForm, fields: string[]): boolean {
  if (fields.length !== form.labels.length) return false;
  if (form.kind !== "choice") return true;
  const options = fields.slice(0, -2);
  return options.every((value, index) => value === "" || value === form.labels[index]) &&
    options.filter(Boolean).length + (fields.at(-2)?.trim() ? 1 : 0) <= form.max_selections;
}

export function newAnswerFieldsMatchForm(form: AnswerForm, fields: string[]): boolean {
  if (!answerFieldsMatchForm(form, fields)) return false;
  if (form.kind !== "choice") return true;
  const options = fields.slice(0, -2);
  return fields.at(-1) === "" &&
    options.filter(Boolean).length + (fields.at(-2)?.trim() ? 1 : 0) <= 1;
}
