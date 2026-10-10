import "server-only";
import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { z } from "zod";
import {
  SESSION_BRIEFING_PROMPT_VERSION,
  SESSION_BRIEFING_SCHEMA_VERSION,
  type BriefingInput,
  briefingInputSchema,
  briefingResultSchema,
} from "@/lib/session-completion/briefing-contract";
import { SESSION_DESIGN_BRIEFING_PROMPT } from "@/lib/ai/prompts/session-design-briefing-v1.1";
import { SESSION_DESIGN_BRIEFING_SCHEMA } from "@/lib/ai/schemas/session-design-briefing-v1.0";
import { SessionBriefingProviderError, type SessionBriefingProvider } from "./session-briefing-service";

export const SESSION_BRIEFING_MOCK_MODEL = "WHY-BOX-LOCAL-MOCK";
export const SESSION_BRIEFING_TIMEOUT_MS = 45_000;

export function sessionBriefingConfig(env: Record<string, string | undefined> = process.env) {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_SESSION_BRIEFING_MODEL?.trim();
  if (env.OPENAI_SESSION_BRIEFING_ENABLED !== "true" || !apiKey || !model) {
    throw new SessionBriefingProviderError("BRIEFING-CONFIG", false);
  }
  return { apiKey, model };
}

export function sessionBriefingParameters(model: string, input: BriefingInput): ResponseCreateParamsNonStreaming {
  const parsed = briefingInputSchema.safeParse(input);
  if (!parsed.success) throw new SessionBriefingProviderError("BRIEFING-INPUT", false);
  const snapshot = parsed.data;
  return {
    model,
    instructions: SESSION_DESIGN_BRIEFING_PROMPT,
    input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify({
      participant_confirmed_context: { ...snapshot.design_context, context_ids: snapshot.context_ids },
      final_answers: snapshot.answered_questions.map(question => ({
        slot_index: question.slot_index, answer: question.answer.selected,
      })),
    }) }] }],
    text: { format: { type: "json_schema", ...SESSION_DESIGN_BRIEFING_SCHEMA } },
    store: false, stream: false, max_output_tokens: 4000,
  };
}

export function extractSessionBriefing(response: unknown) {
  const envelope = z.object({
    status: z.string(), model: z.string().trim().min(1).max(200),
    output: z.array(z.unknown()),
  }).safeParse(response);
  if (!envelope.success) throw new SessionBriefingProviderError("BRIEFING-OUTPUT", false);
  const texts: string[] = [];
  let messages = 0;
  for (const item of envelope.data.output) {
    if (z.object({ type: z.literal("reasoning") }).safeParse(item).success) continue;
    const message = z.object({
      type: z.literal("message"), role: z.literal("assistant"), status: z.string(),
      content: z.array(z.discriminatedUnion("type", [
        z.object({ type: z.literal("output_text"), text: z.string() }).passthrough(),
        z.object({ type: z.literal("refusal"), refusal: z.string() }).passthrough(),
      ])).min(1),
    }).safeParse(item);
    if (!message.success) throw new SessionBriefingProviderError("BRIEFING-OUTPUT", false);
    if (message.data.content.some(part => part.type === "refusal")) {
      throw new SessionBriefingProviderError("BRIEFING-REFUSAL", false);
    }
    if (message.data.status !== "completed") throw new SessionBriefingProviderError("BRIEFING-INCOMPLETE", false);
    messages++;
    for (const part of message.data.content) if (part.type === "output_text") texts.push(part.text);
  }
  if (envelope.data.status !== "completed") throw new SessionBriefingProviderError("BRIEFING-INCOMPLETE", false);
  if (messages !== 1 || texts.length !== 1) throw new SessionBriefingProviderError("BRIEFING-OUTPUT", false);
  let decoded: unknown;
  try { decoded = JSON.parse(texts[0]); }
  catch { throw new SessionBriefingProviderError("BRIEFING-OUTPUT", false); }
  const result = briefingResultSchema.safeParse(decoded);
  if (!result.success) throw new SessionBriefingProviderError("BRIEFING-VALIDATION", false);
  return { response: result.data, model_id: envelope.data.model };
}

export function createLiveSessionBriefingProvider(
  env: Record<string, string | undefined> = process.env,
): SessionBriefingProvider {
  const config = sessionBriefingConfig(env);
  return {
    async generate(input) {
      const parameters = sessionBriefingParameters(config.model, input);
      const client = new OpenAI({
        apiKey: config.apiKey, maxRetries: 0, timeout: SESSION_BRIEFING_TIMEOUT_MS, logLevel: "off",
      });
      try {
        return extractSessionBriefing(await client.responses.create(parameters, {
          signal: AbortSignal.timeout(SESSION_BRIEFING_TIMEOUT_MS),
        }));
      } catch (error) {
        if (error instanceof SessionBriefingProviderError) throw error;
        if (error instanceof OpenAI.APIConnectionTimeoutError) {
          throw new SessionBriefingProviderError("BRIEFING-TIMEOUT", true);
        }
        if (error instanceof OpenAI.APIError) {
          if ([401, 403, 404].includes(error.status ?? 0)) throw new SessionBriefingProviderError("BRIEFING-CONFIG", false);
          if (error.status === 429) throw new SessionBriefingProviderError("BRIEFING-RATE", false);
          if (error.status && error.status >= 400 && error.status < 500) {
            throw new SessionBriefingProviderError("BRIEFING-API", false);
          }
        }
        throw new SessionBriefingProviderError("BRIEFING-API", true);
      }
    },
  };
}

export function createSessionBriefingProvider(env: Record<string, string | undefined> = process.env) {
  if (sessionBriefingMockEnabled(env)) return { provider: createMockSessionBriefingProvider(env), mode: "mock" as const };
  return { provider: createLiveSessionBriefingProvider(env), mode: "openai" as const };
}

export function sessionBriefingMockEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NODE_ENV === "production" || env.SESSION_BRIEFING_MOCK_ENABLED !== "true") return false;
  try {
    const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname.split(".")[0];
    return ref === "njtgxnlxlhxpbiekbgmv";
  } catch {
    return false;
  }
}

export function createMockSessionBriefingProvider(
  env: Record<string, string | undefined> = process.env,
): SessionBriefingProvider {
  if (!sessionBriefingMockEnabled(env)) throw new Error("Session briefing mock is not enabled for this environment.");
  return {
    async generate(input: BriefingInput) {
      const answers = input.answered_questions
        .map(({ answer }) => answer.selected.trim())
        .filter(Boolean);
      if (answers.length === 0) {
        throw new SessionBriefingProviderError("BRIEFING-MOCK-INPUT", false);
      }

      const context = input.design_context.additional_context?.trim();
      const contextSentence = context ? `사용자는 디자인 맥락을 다음과 같이 확인했습니다: “${context}”` : "";
      const answerSentences = answers.map((answer) => `사용자는 “${answer}”라고 설명했습니다.`);
      return {
        response: {
          briefing_text: [contextSentence, ...answerSentences].filter(Boolean).join(" "),
        },
        model_id: SESSION_BRIEFING_MOCK_MODEL,
      };
    },
  };
}

export const sessionBriefingProvenance = {
  prompt_version: SESSION_BRIEFING_PROMPT_VERSION,
  schema_version: SESSION_BRIEFING_SCHEMA_VERSION,
  prompt: SESSION_DESIGN_BRIEFING_PROMPT,
  schema: SESSION_DESIGN_BRIEFING_SCHEMA,
} as const;
