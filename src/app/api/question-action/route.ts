import { NextRequest,NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireActiveParticipant,AnswerError } from "@/lib/answers/server";
import { recordParticipantActivity } from "@/lib/activity/record";
import { readGenerationView } from "@/lib/question-generation/read";
import { readQuestionActionCapabilities } from "@/lib/question-generation/actions-server";
import { questionActionRequestSchema,questionActionCommitSchema,
  QuestionActionError,questionActionMessages } from "@/lib/question-generation/actions-contract";
import {z} from "zod";
import {questionRegenerationEnabled} from "@/lib/ai/server/question-regeneration-config";
import {runQuestionRegeneration,recoverQuestionRegeneration} from "@/lib/ai/server/question-regeneration-service";
import {createRegenerationRepository} from "@/lib/question-generation/regeneration-repository";
import {regenerationMessages} from "@/lib/question-generation/regeneration-contract";

export const runtime="nodejs";
export const maxDuration=120;
const headers={"Cache-Control":"no-store"};
function actionError(error:unknown) {
  const safe=error instanceof QuestionActionError?error:error instanceof AnswerError?
    new QuestionActionError(error.code==="ANSWER-AUTH"?"QA-AUTH":"QA-DB",error.status):new QuestionActionError("QA-DB");
  console.error(`WHY BOX question actions: ${safe.code}`);
  return NextResponse.json({errorCode:safe.code,message:regenerationMessages[safe.code]??questionActionMessages[safe.code]??questionActionMessages["QA-DB"]},
    {status:safe.status,headers});
}
async function responseForResult(result:unknown,caller:Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId:string,sessionId:string,action:"skip"|"regenerate") {
  const committed=questionActionCommitSchema.safeParse(result);
  if(!committed.success)throw new QuestionActionError("QR-RECOVERY");
  const view=await readGenerationView(caller,userId,sessionId);
  const activityRecorded=committed.data.changed?await recordParticipantActivity(
    action==="skip"?"question_skipped":"question_regenerated"):true;
  return NextResponse.json({...committed.data,view,activity_recorded:activityRecorded},{headers});
}
export async function GET(request:NextRequest) {
  try {
    const input=z.object({session_id:z.uuid(),request_id:z.uuid()}).strict()
      .safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if(!input.success)throw new QuestionActionError("QA-INPUT",400);
    const caller=await createSupabaseServerClient();
    const userId=await requireActiveParticipant(caller,new AbortController().signal);
    const repo=createRegenerationRepository(caller,createSupabaseAdminClient(),userId);
    const result=await recoverQuestionRegeneration(repo,input.data.session_id,input.data.request_id);
    if("status" in result)return NextResponse.json({...result,retry_after_ms:1000},{status:202,headers});
    if(result.request_id!==input.data.request_id)throw new QuestionActionError("QR-RECOVERY");
    return await responseForResult(result,caller,userId,input.data.session_id,"regenerate");
  } catch(error) {return actionError(error);}
}
export async function POST(request:NextRequest) {
  try {
    const protocol=request.headers.get("x-forwarded-proto")??request.nextUrl.protocol.slice(0,-1);
    const host=request.headers.get("host");
    if(!host||request.headers.get("origin")!==`${protocol}://${host}`)throw new QuestionActionError("QA-AUTH",403);
    const reader=request.body?.getReader();
    if(!reader)throw new QuestionActionError("QA-INPUT",400);
    const chunks:Uint8Array[]=[];let size=0;
    while(true) {
      const chunk=await reader.read();if(chunk.done)break;
      size+=chunk.value.length;
      if(size>4096){await reader.cancel();throw new QuestionActionError("QA-INPUT",413);}
      chunks.push(chunk.value);
    }
    let body:unknown;
    try {body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}
    catch {throw new QuestionActionError("QA-INPUT",400);}
    const input=questionActionRequestSchema.safeParse(body);
    if(!input.success)throw new QuestionActionError("QA-INPUT",400);
    const caller=await createSupabaseServerClient();
    const userId=await requireActiveParticipant(caller,new AbortController().signal);
    const session=await caller.from("sessions").select("id")
      .eq("id",input.data.session_id).eq("participant_id",userId).maybeSingle();
    if(session.error)throw new QuestionActionError("QA-DB");
    if(!session.data)throw new QuestionActionError("QA-AUTH",403);
    const caps=await readQuestionActionCapabilities(caller,input.data.session_id);
    if(!caps.ready)throw new QuestionActionError("QA-UNAVAILABLE",409);
    const trusted=createSupabaseAdminClient();
    if(input.data.action==="regenerate"&&questionRegenerationEnabled()) {
      if(!caps.regeneration)throw new QuestionActionError("QA-UNAVAILABLE",409);
      const result=await runQuestionRegeneration(createRegenerationRepository(caller,trusted,userId),input.data);
      if("status" in result)return NextResponse.json({...result,retry_after_ms:1000},{status:202,headers});
      if(result.request_id!==input.data.request_id||result.question_id!==input.data.question_id)throw new QuestionActionError("QR-RECOVERY");
      return await responseForResult(result,caller,userId,input.data.session_id,"regenerate");
    }
    const result=await trusted.rpc("apply_question_action",{
      p_session_id:input.data.session_id,p_question_id:input.data.question_id,p_request_id:input.data.request_id,
      p_action:input.data.action,p_participant_id:userId,p_expected_answer_revision:input.data.expected_answer_revision,
    });
    if(result.error) {
      const codes:Record<string,[string,number]>={
        "42501":["QA-AUTH",403],"22023":["QA-INPUT",400],"55000":["QA-STATE",409],
        "40001":["QA-STALE",409],"P0002":["QA-RESERVE",409],"54000":["QA-LIMIT",409],
        "PGRST202":["QA-UNAVAILABLE",409],"42883":["QA-UNAVAILABLE",409],
      };
      const [code,status]=codes[result.error.code]??["QA-DB",503];
      throw new QuestionActionError(code,status);
    }
    const committed=questionActionCommitSchema.safeParse(result.data);
    if(!committed.success||committed.data.request_id!==input.data.request_id||
      committed.data.question_id!==input.data.question_id)throw new QuestionActionError("QA-DB");
    const view=await readGenerationView(caller,userId,input.data.session_id);
    const activityRecorded=committed.data.changed?await recordParticipantActivity(
      input.data.action==="skip"?"question_skipped":"question_regenerated"):true;
    return NextResponse.json({...committed.data,view,activity_recorded:activityRecorded},{headers});
  } catch(error) {
    return actionError(error);
  }
}
