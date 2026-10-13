import "server-only";
import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming, ResponseInputContent } from "openai/resources/responses/responses";
import { z } from "zod";
import { SENTENCE_REFINEMENT_PROMPT } from "../prompts/sentence-refinement-v1.1";
import { SentenceRefinementError, SENTENCE_REFINEMENT_MAX_CHARACTERS } from "../sentence-refinement-contract";
import { SENTENCE_REFINEMENT_TIMEOUT_MS } from "./sentence-refinement-config";

export function sentenceRefinementParameters(model:string,answer:string):ResponseCreateParamsNonStreaming {
  const text=answer.trim();
  if(!text || answer.length>SENTENCE_REFINEMENT_MAX_CHARACTERS) {
    throw new SentenceRefinementError(text?"REFINE-INPUT":"REFINE-EMPTY",text?400:422);
  }
  const content:ResponseInputContent[]=[{type:"input_text",text}];
  return {
    model,instructions:SENTENCE_REFINEMENT_PROMPT,
    input:[{role:"user",content}],
    store:false,stream:false,max_output_tokens:4000,
  };
}

const outputMessageSchema=z.object({
  type:z.literal("message"),role:z.literal("assistant"),status:z.string(),
  content:z.array(z.discriminatedUnion("type",[
    z.object({type:z.literal("output_text"),text:z.string()}).passthrough(),
    z.object({type:z.literal("refusal"),refusal:z.string()}).passthrough(),
  ])).min(1),
}).passthrough();

export function extractRefinedSentence(response:unknown):string {
  const parsed=z.object({status:z.string(),output:z.array(z.unknown())}).safeParse(response);
  if(!parsed.success)throw new SentenceRefinementError("REFINE-OUTPUT",502);
  const messages:z.infer<typeof outputMessageSchema>[]=[];
  for(const item of parsed.data.output) {
    if(z.object({type:z.literal("reasoning")}).safeParse(item).success)continue;
    const message=outputMessageSchema.safeParse(item);
    if(!message.success)throw new SentenceRefinementError("REFINE-OUTPUT",502);
    messages.push(message.data);
  }
  if(messages.some(item=>item.content.some(part=>part.type==="refusal"))) {
    throw new SentenceRefinementError("REFINE-REFUSAL",422);
  }
  if(parsed.data.status!=="completed" || messages.some(item=>item.status!=="completed")) {
    throw new SentenceRefinementError("REFINE-INCOMPLETE",502);
  }
  if(messages.length!==1)throw new SentenceRefinementError("REFINE-OUTPUT",502);
  const text=messages[0].content.flatMap(part=>part.type==="output_text"?[part.text]:[]).join("\n").trim();
  if(!text || text.length>SENTENCE_REFINEMENT_MAX_CHARACTERS ||
    /```|^(?:#{1,6}\s|[-*]\s|\d+[.)]\s)/mu.test(text) ||
    /^(?:다듬은 문장|수정(?:한)? 문장|수정 이유|점수|코멘트)\s*[:：]/u.test(text) ||
    /^(?:수정한 문장은 다음과 같습니다|좋은 (?:답변|관점|생각)입니다|이렇게 개선하면 좋겠습니다|추가로 .*해보면 좋겠습니다)/u.test(text)) {
    throw new SentenceRefinementError("REFINE-OUTPUT",502);
  }
  return text;
}

export async function refineSentence(
  config:{apiKey:string;model:string},answer:string,signal:AbortSignal,
):Promise<string> {
  const parameters=sentenceRefinementParameters(config.model,answer);
  if(signal.aborted)throw new SentenceRefinementError("REFINE-TIMEOUT",504);
  const client=new OpenAI({apiKey:config.apiKey,maxRetries:0,timeout:SENTENCE_REFINEMENT_TIMEOUT_MS,logLevel:"off"});
  try {
    return extractRefinedSentence(await client.responses.create(parameters,{signal}));
  } catch(error) {
    if(error instanceof SentenceRefinementError) throw error;
    if(signal.aborted || error instanceof OpenAI.APIConnectionTimeoutError) {
      throw new SentenceRefinementError("REFINE-TIMEOUT",504);
    }
    if(error instanceof OpenAI.APIError && error.status===429) {
      const quotaExceeded=error.code==="insufficient_quota" || error.code==="billing_hard_limit_reached";
      console.error("WHY BOX sentence refinement provider rejected request", {
        status:429,category:quotaExceeded?"quota_exhausted":"rate_limited",
      });
      if(quotaExceeded)throw new SentenceRefinementError("REFINE-QUOTA",503);
      throw new SentenceRefinementError("REFINE-RATE",429);
    }
    if(error instanceof OpenAI.APIError && ([401,403,404].includes(error.status??0) ||
      ["model_not_found","invalid_api_key","unsupported_model"].includes(error.code??""))) {
      throw new SentenceRefinementError("REFINE-CONFIG",503);
    }
    throw new SentenceRefinementError("REFINE-API",502);
  }
}
