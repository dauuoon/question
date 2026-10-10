import { NextRequest,NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { recordParticipantActivity } from "@/lib/activity/record";
import { AnswerError,readAnswer,requireActiveParticipant,requireEditableQuestion } from "@/lib/answers/server";
import {
  SentenceRefinementError,sentenceRefinementErrorMessages,sentenceRefinementRequestSchema,
  sentenceRefinementResultSchema,SENTENCE_REFINEMENT_MAX_CHARACTERS,
} from "@/lib/ai/sentence-refinement-contract";
import { sentenceRefinementConfig,SENTENCE_REFINEMENT_TIMEOUT_MS } from "@/lib/ai/server/sentence-refinement-config";
import { refineSentence } from "@/lib/ai/server/sentence-refinement";
import { runSentenceRefinement } from "@/lib/ai/server/sentence-refinement-flight";

export const runtime="nodejs";
export const maxDuration=70;
const MAX_BODY_BYTES=2_048;
const headers={"Cache-Control":"no-store"};

function mapAnswerError(error:AnswerError):SentenceRefinementError {
  if(error.code==="ANSWER-AUTH") return new SentenceRefinementError("REFINE-AUTH",403);
  if(error.code==="ANSWER-STATE") return new SentenceRefinementError("REFINE-STATE",409);
  if(error.code==="ANSWER-STALE") return new SentenceRefinementError("REFINE-STALE",409);
  return new SentenceRefinementError("REFINE-DB",503);
}

export async function POST(request:NextRequest) {
  const controller=new AbortController();
  const cancel=()=>controller.abort("cancelled");
  const timer=setTimeout(()=>controller.abort("timeout"),SENTENCE_REFINEMENT_TIMEOUT_MS);
  request.signal.addEventListener("abort",cancel,{once:true});
  if(request.signal.aborted) cancel();
  try {
    const protocol=request.headers.get("x-forwarded-proto")??request.nextUrl.protocol.slice(0,-1);
    const host=request.headers.get("host");
    if(!host || request.headers.get("origin")!==`${protocol}://${host}`) throw new SentenceRefinementError("REFINE-AUTH",403);
    const reader=request.body?.getReader();
    if(!reader) throw new SentenceRefinementError("REFINE-INPUT",400);
    const chunks:Uint8Array[]=[];let size=0;
    while(true) {
      const chunk=await reader.read();
      if(chunk.done) break;
      size+=chunk.value.length;
      if(size>MAX_BODY_BYTES) {await reader.cancel();throw new SentenceRefinementError("REFINE-INPUT",413);}
      chunks.push(chunk.value);
    }
    let body:unknown;
    try {body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}
    catch {throw new SentenceRefinementError("REFINE-INPUT",400);}
    const parsed=sentenceRefinementRequestSchema.safeParse(body);
    if(!parsed.success) throw new SentenceRefinementError("REFINE-INPUT",400);

    const caller=await createSupabaseServerClient();
    let userId:string;
    try {userId=await requireActiveParticipant(caller,controller.signal);}
    catch(error) {if(error instanceof AnswerError) throw mapAnswerError(error);throw error;}
    try {await requireEditableQuestion(caller,userId,parsed.data.question_id,controller.signal);}
    catch(error) {if(error instanceof AnswerError) throw mapAnswerError(error);throw error;}
    const answer=await readAnswer(caller,parsed.data.question_id,controller.signal);
    if(!answer || answer.updated_at!==parsed.data.expected_updated_at) {
      throw new SentenceRefinementError("REFINE-STALE",409);
    }
    const source=answer.current_answer_version==="refined"?
      answer.refined_answer??"":answer.original_answer;
    if(!source.trim()) throw new SentenceRefinementError("REFINE-EMPTY",422);
    if(source.length>SENTENCE_REFINEMENT_MAX_CHARACTERS)throw new SentenceRefinementError("REFINE-INPUT",400);
    const config=sentenceRefinementConfig();
    const result=await runSentenceRefinement(userId,parsed.data.question_id,answer.updated_at,async()=>{
      const refined=await refineSentence(config,source,controller.signal);
      if(controller.signal.aborted) throw new SentenceRefinementError("REFINE-TIMEOUT",504);
      if(!sentenceRefinementResultSchema.shape.refined_text.safeParse(refined).success) {
        throw new SentenceRefinementError("REFINE-OUTPUT",502);
      }
      try {await requireEditableQuestion(caller,userId,parsed.data.question_id,controller.signal);}
      catch(error) {if(error instanceof AnswerError) throw mapAnswerError(error);throw error;}
      const current=await readAnswer(caller,parsed.data.question_id,controller.signal);
      if(!current || current.updated_at!==answer.updated_at ||
        current.current_answer_version!==answer.current_answer_version ||
        (current.current_answer_version==="refined" ? current.refined_answer : current.original_answer)!==source) {
        throw new SentenceRefinementError("REFINE-STALE",409);
      }
      if(controller.signal.aborted)throw new SentenceRefinementError("REFINE-TIMEOUT",504);
      const refinedAt=new Date().toISOString();
      const saved=await caller.from("answers").update({
        refined_answer:refined,refinement_used:true,refined_at:refinedAt,current_answer_version:"refined",
      }).eq("question_id",parsed.data.question_id).eq("updated_at",answer.updated_at)
        .abortSignal(controller.signal).select("updated_at").maybeSingle();
      if(saved.error) {
        if(controller.signal.aborted)throw new SentenceRefinementError("REFINE-TIMEOUT",504);
        if(saved.error.code==="42501") throw new SentenceRefinementError("REFINE-AUTH",403);
        throw new SentenceRefinementError("REFINE-DB",503);
      }
      if(!saved.data) throw new SentenceRefinementError("REFINE-STALE",409);
      const output=sentenceRefinementResultSchema.safeParse({refined_text:refined,updated_at:saved.data.updated_at});
      if(!output.success)throw new SentenceRefinementError("REFINE-DB",503);
      await recordParticipantActivity("answer_saved");
      return output.data;
    });
    return NextResponse.json(result,{headers});
  } catch(error) {
    const safe=error instanceof SentenceRefinementError?error:
      error instanceof AnswerError?mapAnswerError(error):new SentenceRefinementError(
        controller.signal.aborted?"REFINE-TIMEOUT":"REFINE-API",controller.signal.aborted?504:502,
      );
    console.error(`WHY BOX sentence refinement: ${safe.code}`);
    return NextResponse.json({errorCode:safe.code,
      message:sentenceRefinementErrorMessages[safe.code]??sentenceRefinementErrorMessages["REFINE-API"]},
    {status:safe.status,headers:{...headers,...(safe.status===429?{"Retry-After":"60"}:{})}});
  } finally {
    clearTimeout(timer);request.signal.removeEventListener("abort",cancel);
  }
}
