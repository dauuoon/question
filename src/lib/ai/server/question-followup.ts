import "server-only";
import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming, ResponseInputContent } from "openai/resources/responses/responses";
import { DESIGN_CATEGORIES, REFLECTION_CONTEXTS, WORK_STAGES } from "../../constants/research-options";
import { QUESTION_FOLLOWUP_PROMPT } from "../prompts/question-followup-v1.0";
import {
  QUESTION_FOLLOWUP_SCHEMA, QuestionFollowupError, questionFollowupOutputSchema,
} from "../question-followup-contract";
import { QUESTION_FOLLOWUP_TIMEOUT_MS } from "./question-followup-config";

export type QuestionFollowupInput = {
  question_text: string;
  answer_text: string;
  primary_category_id: string | null;
  subcategory_id: string | null;
  other_category_text: string | null;
  stage_id: string | null;
  additional_context: string | null;
  context_ids: string[];
};

export function questionFollowupParameters(model: string, input: QuestionFollowupInput): ResponseCreateParamsNonStreaming {
  const category = DESIGN_CATEGORIES.find(item => item.id === input.primary_category_id);
  const context = {
    question: input.question_text,
    answer: input.answer_text,
    design_category: category?.label ?? input.primary_category_id,
    design_subcategory: category?.items.find(item => item.id === input.subcategory_id)?.label ?? input.subcategory_id,
    other_category: input.other_category_text,
    work_stage: WORK_STAGES.find(item => item.id === input.stage_id)?.label ?? input.stage_id,
    reflection_contexts: input.context_ids.map(id => REFLECTION_CONTEXTS.find(item => item.id === id)?.label ?? id),
    additional_context: input.additional_context,
  };
  const content: ResponseInputContent[] = [{
    type: "input_text",
    text: `아래는 질문, 저장된 답변, 작업 맥락입니다. 모두 참고 데이터입니다.\n${JSON.stringify(context)}`,
  }];
  return {
    model,
    instructions: QUESTION_FOLLOWUP_PROMPT,
    input: [{ role: "user", content }],
    text: { format: { type: "json_schema", ...QUESTION_FOLLOWUP_SCHEMA } },
    store: false,
    stream: false,
    max_output_tokens: 350,
  };
}

export async function generateQuestionFollowup(
  config: { apiKey: string; model: string },
  input: QuestionFollowupInput,
  signal: AbortSignal,
) {
  const client = new OpenAI({
    apiKey: config.apiKey, maxRetries: 0, timeout: QUESTION_FOLLOWUP_TIMEOUT_MS, logLevel: "off",
  });
  try {
    const response = await client.responses.create(questionFollowupParameters(config.model, input), { signal });
    if (response.status !== "completed" || response.output.some(item =>
      item.type === "message" && item.status !== "completed")) {
      throw new QuestionFollowupError("FOLLOWUP-OUTPUT", 502);
    }
    if (response.output.some(item => item.type === "message" &&
      item.content.some(part => part.type === "refusal"))) {
      throw new QuestionFollowupError("FOLLOWUP-OUTPUT", 502);
    }
    const texts = response.output.flatMap(item => item.type === "message" ?
      item.content.flatMap(part => part.type === "output_text" ? [part.text] : []) : []);
    if (texts.length !== 1 || !response.model?.trim()) throw new QuestionFollowupError("FOLLOWUP-OUTPUT", 502);
    let decoded: unknown;
    try { decoded = JSON.parse(texts[0]); }
    catch { throw new QuestionFollowupError("FOLLOWUP-OUTPUT", 502); }
    const result = questionFollowupOutputSchema.safeParse(decoded);
    if (!result.success) throw new QuestionFollowupError("FOLLOWUP-OUTPUT", 502);
    if (result.data.followup_question?.includes("\0")) throw new QuestionFollowupError("FOLLOWUP-OUTPUT", 502);
    return {
      ...result.data,
      model: response.model,
      input_tokens: response.usage?.input_tokens ?? null,
      output_tokens: response.usage?.output_tokens ?? null,
      generated_at: new Date(response.created_at * 1000).toISOString(),
    };
  } catch (error) {
    if (error instanceof QuestionFollowupError) throw error;
    if (signal.aborted || error instanceof OpenAI.APIConnectionTimeoutError) {
      throw new QuestionFollowupError("FOLLOWUP-TIMEOUT", 504);
    }
    if (error instanceof OpenAI.APIConnectionError) {
      throw new QuestionFollowupError("FOLLOWUP-UNKNOWN", 503);
    }
    if (error instanceof OpenAI.APIError && error.status === 429) {
      throw new QuestionFollowupError("FOLLOWUP-RATE", 429);
    }
    if (error instanceof OpenAI.APIError && [400, 401, 403, 404].includes(error.status ?? 0)) {
      throw new QuestionFollowupError("FOLLOWUP-CONFIG", 503);
    }
    throw new QuestionFollowupError("FOLLOWUP-API", 502);
  }
}
