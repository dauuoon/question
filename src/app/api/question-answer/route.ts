import { NextRequest,NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { recordParticipantActivity } from "@/lib/activity/record";
import { AnswerError,readAnswer,requireActiveParticipant,requireEditableQuestion } from "@/lib/answers/server";
import { answerRevisionSchema } from "@/lib/answers/revision";
import { answerSaveErrorMessages } from "@/lib/answers/contract";

export const runtime="nodejs";
const MAX_BODY_BYTES=65_536;
const MAX_ANSWER_CHARACTERS=20_000;
const requestSchema=z.object({
  question_id:z.uuid(),answer_text:z.string().max(MAX_ANSWER_CHARACTERS),
  answer_version:z.enum(["original","refined"]),expected_updated_at:answerRevisionSchema.nullable(),
}).strict();
const headers={"Cache-Control":"no-store"};

export async function POST(request:NextRequest) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15_000);
  try {
    const protocol=request.headers.get("x-forwarded-proto")??request.nextUrl.protocol.slice(0,-1);
    const host=request.headers.get("host");
    if(!host || request.headers.get("origin")!==`${protocol}://${host}`) throw new AnswerError("ANSWER-AUTH",403);
    const reader=request.body?.getReader();
    if(!reader) throw new AnswerError("ANSWER-INPUT",400);
    const chunks:Uint8Array[]=[];let size=0;
    while(true) {
      const chunk=await reader.read();
      if(chunk.done) break;
      size+=chunk.value.length;
      if(size>MAX_BODY_BYTES) {await reader.cancel();throw new AnswerError("ANSWER-LENGTH",413);}
      chunks.push(chunk.value);
    }
    let body:unknown;
    try {body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}
    catch {throw new AnswerError("ANSWER-INPUT",400);}
    const parsed=requestSchema.safeParse(body);
    if(!parsed.success) throw new AnswerError("ANSWER-INPUT",400);

    const caller=await createSupabaseServerClient();
    const userId=await requireActiveParticipant(caller,controller.signal);
    await requireEditableQuestion(caller,userId,parsed.data.question_id,controller.signal);
    const existing=await readAnswer(caller,parsed.data.question_id,controller.signal);
    if(existing) {
      if(parsed.data.expected_updated_at!==existing.updated_at) throw new AnswerError("ANSWER-STALE",409);
      if(parsed.data.answer_version==="refined" && (!existing.refinement_used || existing.refined_answer===null)) {
        throw new AnswerError("ANSWER-STATE",409);
      }
      const current=existing.current_answer_version==="refined" ?
        existing.refined_answer??"" : existing.original_answer;
      if(current===parsed.data.answer_text && existing.current_answer_version===parsed.data.answer_version) {
        return NextResponse.json({success:true,answer_version:existing.current_answer_version,updated_at:existing.updated_at}, {headers});
      }
      const changes=parsed.data.answer_version==="refined" ?
        {refined_answer:parsed.data.answer_text,current_answer_version:"refined"} :
        {original_answer:parsed.data.answer_text,current_answer_version:"original"};
      const updated=await caller.from("answers").update(changes).eq("question_id",parsed.data.question_id)
        .eq("updated_at",existing.updated_at).select("current_answer_version,updated_at").maybeSingle();
      if(updated.error) throw new AnswerError(updated.error.code==="42501"?"ANSWER-AUTH":"ANSWER-DB",
        updated.error.code==="42501"?403:503);
      if(!updated.data) throw new AnswerError("ANSWER-STALE",409);
      const activityRecorded=await recordParticipantActivity("answer_saved");
      return NextResponse.json({success:true,answer_version:updated.data.current_answer_version,
        updated_at:updated.data.updated_at,activity_recorded:activityRecorded},{headers});
    }
    if(parsed.data.expected_updated_at!==null || parsed.data.answer_version!=="original") {
      throw new AnswerError("ANSWER-STALE",409);
    }
    const inserted=await caller.from("answers").insert({
      question_id:parsed.data.question_id,participant_id:userId,original_answer:parsed.data.answer_text,
    }).select("current_answer_version,updated_at").maybeSingle();
    if(inserted.error) throw new AnswerError(inserted.error.code==="42501"?"ANSWER-AUTH":
      inserted.error.code==="23505"?"ANSWER-STALE":"ANSWER-DB",
    inserted.error.code==="42501"?403:inserted.error.code==="23505"?409:503);
    if(!inserted.data) throw new AnswerError("ANSWER-DB");
    const activityRecorded=await recordParticipantActivity("answer_saved");
    return NextResponse.json({success:true,answer_version:inserted.data.current_answer_version,
      updated_at:inserted.data.updated_at,activity_recorded:activityRecorded},{headers});
  } catch(error) {
    const safe=error instanceof AnswerError?error:new AnswerError("ANSWER-DB");
    console.error(`WHY BOX answer save: ${safe.code}`);
    return NextResponse.json({errorCode:safe.code,
      message:answerSaveErrorMessages[safe.code]??answerSaveErrorMessages["ANSWER-DB"]},
      {status:safe.status,headers});
  } finally {clearTimeout(timer);}
}
