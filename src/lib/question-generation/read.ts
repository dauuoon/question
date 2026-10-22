import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { QuestionGenerationError } from "../ai/question-generation-contract";
import { generationViewSchema, type GenerationView } from "./view-contract";
import { IMAGE_BUCKET } from "../images/limits";
import { QUESTION_GENERATION_SIGNED_URL_SECONDS } from "../ai/server/question-generation-config";
import { answerRevisionSchema } from "../answers/revision";
import { readQuestionActionCapabilities } from "./actions-server";
import { readQuestionFollowupAccess } from "./followup-access";

const sessionSnapshotSchema = z.object({
  id: z.uuid(), participant_id: z.uuid(),
  status: z.enum(["draft", "question_generation", "in_progress", "summary_ready", "completed"]),
  requested_question_count: z.number().int().min(1).max(5),
});
type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

export async function readGenerationView(caller: SupabaseClient, userId: string, sessionId: string,
  savedSession?: SessionSnapshot): Promise<GenerationView> {
  if (!z.uuid().safeParse(sessionId).success) throw new QuestionGenerationError("QGEN-INPUT", 400);
  const snapshot = savedSession === undefined ? null : sessionSnapshotSchema.safeParse(savedSession);
  if (snapshot && (!snapshot.success || snapshot.data.id !== sessionId || snapshot.data.participant_id !== userId)) {
    throw new QuestionGenerationError("QGEN-AUTH", 403);
  }
  const session = snapshot?.success ? { data: snapshot.data, error: null } :
    await caller.from("sessions").select("status,requested_question_count")
      .eq("id", sessionId).eq("participant_id", userId).maybeSingle();
  if (session.error) throw new QuestionGenerationError("QGEN-DB", 503);
  if (!session.data) throw new QuestionGenerationError("QGEN-AUTH", 403);
  const parsedSession = z.object({ status: z.enum(["draft", "question_generation", "in_progress", "summary_ready", "completed"]),
    requested_question_count: z.number().int().min(1).max(5) }).safeParse(session.data);
  if (!parsedSession.success) throw new QuestionGenerationError("QGEN-DB", 503);
  const followupAccess = await readQuestionFollowupAccess(caller, userId);
  const [attempts, questions] = await Promise.all([
    caller.from("question_generation_attempts")
    .select("status,generated_at,request_id").eq("session_id", sessionId)
    .order("started_at", { ascending: false }).limit(1),
    caller.from("questions").select("id,slot_index,question_text,status,regeneration_index")
    .eq("session_id", sessionId).in("question_kind",["original","regenerated"])
    .eq("is_active_version",true).order("slot_index"),
  ]);
  if (attempts.error || !attempts.data || questions.error || !questions.data) {
    throw new QuestionGenerationError("QGEN-DB", 503);
  }
  const parsedAttempts = z.array(z.object({ status: z.enum(["running", "completed", "failed"]),
    generated_at: z.string().nullable(), request_id: z.uuid() })).max(1).safeParse(attempts.data);
  if (!parsedAttempts.success) throw new QuestionGenerationError("QGEN-DB", 503);
  const attempt = parsedAttempts.data[0];
  const state = attempt?.status === "running" ? (attempt.generated_at ? "recovery" : "running") :
    ["in_progress", "summary_ready", "completed"].includes(parsedSession.data.status) ? "completed" :
      questions.data.length > 0 || attempt?.status === "completed" ||
        (parsedSession.data.status === "question_generation" && attempt?.status !== "failed") ? "recovery" : "editable";
  let savedQuestions: GenerationView["questions"] = [];
  let signedImages: Array<{id:string;sort_order:number;width:number|null;height:number|null;signed_url:string}> = [];
  let answerEditable = false;
  let capabilities: GenerationView["question_actions"] = {ready:false,reserve_count:0,reserve_count_by_question:{}};
  if (state === "completed") {
    const saved = z.array(z.object({
      id:z.uuid(),slot_index:z.number().int(),question_text:z.string(),
      status:z.enum(["unprocessed","answered","skipped"]),regeneration_index:z.number().int().min(0).max(2),
    }).strict()).max(5).safeParse(questions.data);
    if (!saved.success) throw new QuestionGenerationError("QGEN-RECOVERY",503);
    const [imageRows, targetRows, actions, followupRows] = await Promise.all([
      caller.from("session_images")
        .select("id,storage_path,sort_order,width,height").eq("session_id",sessionId).order("sort_order"),
      caller.from("question_targets")
        .select("question_id,image_id,x,y,width,height,sort_order").eq("session_id",sessionId).order("sort_order"),
      readQuestionActionCapabilities(caller,sessionId),
      caller.from("questions").select("id,parent_question_id,question_text,status")
        .eq("session_id",sessionId).eq("question_kind","followup").order("created_at"),
    ]);
    const followupRequests = followupAccess.enabled || (followupRows.data?.length ?? 0) > 0 ?
      await Promise.all(saved.data.map(question => caller.from("question_followup_requests")
        .select("request_id,parent_question_id,status,answer_snapshot,created_at,prompt_version,model_id,input_tokens,output_tokens")
        .eq("session_id",sessionId).eq("participant_id",userId).eq("parent_question_id",question.id)
        .order("created_at",{ascending:false}).order("id",{ascending:false}).limit(1))) : [];
    capabilities = actions;
    if (imageRows.error || !imageRows.data || targetRows.error || !targetRows.data ||
      followupRows.error || !followupRows.data ||
      followupRequests.some(result=>result.error || !result.data)) {
      throw new QuestionGenerationError("QGEN-DB",503);
    }
    if (followupRequests.some(result=>(result.data?.length ?? 0)>1)) {
      throw new QuestionGenerationError("QGEN-RECOVERY",503);
    }
    const images = z.array(z.object({
      id:z.uuid(),storage_path:z.string().min(1),sort_order:z.number().int().nonnegative(),
      width:z.number().int().positive().nullable(),height:z.number().int().positive().nullable(),
    }).strict()).max(10).safeParse(imageRows.data);
    const targets = z.array(z.object({
      question_id:z.uuid(),image_id:z.uuid(),x:z.number().nullable(),y:z.number().nullable(),
      width:z.number().nullable(),height:z.number().nullable(),sort_order:z.number().int().nonnegative(),
    }).strict()).safeParse(targetRows.data);
    const followups=z.array(z.object({
      id:z.uuid(),parent_question_id:z.uuid(),
      question_text:z.string().min(1),status:z.enum(["unprocessed","answered","skipped"]),
    }).strict()).max(5).safeParse(followupRows.data);
    const requests=z.array(z.object({
      request_id:z.uuid(),parent_question_id:z.uuid(),
      status:z.enum(["reserved","dispatch_started","generated","no_followup","failed","outcome_unknown"]),
      answer_snapshot:z.string(),created_at:z.string(),prompt_version:z.string().min(1),
      model_id:z.string().nullable(),input_tokens:z.number().int().nonnegative().nullable(),
      output_tokens:z.number().int().nonnegative().nullable(),
    }).strict()).max(5).safeParse(followupRequests.flatMap(result=>result.data ?? []));
    if (!images.success || !targets.success || !saved.success || !followups.success || !requests.success ||
      new Set(requests.data.map(request=>request.parent_question_id)).size!==requests.data.length ||
      requests.data.some(request=>!saved.data.some(question=>question.id===request.parent_question_id)) ||
      images.data.some((image) => !image.storage_path.startsWith(`${userId}/${sessionId}/`))) {
      throw new QuestionGenerationError("QGEN-RECOVERY",503);
    }
    const allQuestionIds=[...saved.data.map(question=>question.id),...followups.data.map(question=>question.id)];
    const [answerRows, urls] = await Promise.all([
      allQuestionIds.length ? caller.from("answers")
      .select("question_id,original_answer,refined_answer,refinement_used,current_answer_version,updated_at")
      .in("question_id",allQuestionIds) : {data:[],error:null},
      Promise.all(images.data.map(async (image) => {
        const signed = await caller.storage.from(IMAGE_BUCKET)
          .createSignedUrl(image.storage_path,QUESTION_GENERATION_SIGNED_URL_SECONDS);
        if (signed.error || !signed.data?.signedUrl) throw new QuestionGenerationError("QGEN-IMAGE",503);
        return {id:image.id,sort_order:image.sort_order,width:image.width,height:image.height,signed_url:signed.data.signedUrl};
      })),
    ]);
    if(answerRows.error || !answerRows.data) throw new QuestionGenerationError("QGEN-DB",503);
    const answers = z.array(z.object({
      question_id:z.uuid(),original_answer:z.string(),refined_answer:z.string().nullable(),
      refinement_used:z.boolean(),current_answer_version:z.enum(["original","refined"]),
      updated_at:answerRevisionSchema,
    }).strict()).safeParse(answerRows.data);
    if(!answers.success || new Set(answers.data.map((answer)=>answer.question_id)).size!==answers.data.length ||
      answers.data.some((answer)=>!allQuestionIds.includes(answer.question_id))) {
      throw new QuestionGenerationError("QGEN-RECOVERY",503);
    }
    const byQuestion = new Map<string, typeof targets.data>();
    for (const target of targets.data) byQuestion.set(target.question_id,[...(byQuestion.get(target.question_id) ?? []),target]);
    const answerByQuestion=new Map(answers.data.map(answer=>[answer.question_id,answer]));
    const followupByParent=new Map(followups.data.map(question=>[question.parent_question_id,question]));
    const latestRequestByParent=new Map<string,(typeof requests.data)[number]>();
    for(const item of requests.data) if(!latestRequestByParent.has(item.parent_question_id)) {
      latestRequestByParent.set(item.parent_question_id,item);
    }
    const answerFor=(questionId:string)=>{
      const answer=answerByQuestion.get(questionId);
      return answer ? {
        original_answer:answer.original_answer,refined_answer:answer.refined_answer,
        refinement_used:answer.refinement_used,current_answer_version:answer.current_answer_version,
        updated_at:answer.updated_at,
      } : {
        original_answer:"",refined_answer:null,refinement_used:false,
        current_answer_version:"original" as const,updated_at:null,
      };
    };
    savedQuestions = saved.data.map((question) => ({
      ...question,
      targets:(byQuestion.get(question.id) ?? []).map((target) => ({
        image_id:target.image_id,x:target.x,y:target.y,width:target.width,height:target.height,sort_order:target.sort_order,
      })),
      answer:answerFor(question.id),
      followup_question:(()=>{
        const child=followupByParent.get(question.id);
        return child?{id:child.id,question_text:child.question_text,status:child.status,answer:answerFor(child.id)}:null;
      })(),
      last_followup_request:(()=>{
        const request=latestRequestByParent.get(question.id);
        if(!request)return null;
        const {parent_question_id:parentId,...display}=request;
        return parentId===question.id?display:null;
      })(),
    }));
    answerEditable=parsedSession.data.status==="in_progress";
    signedImages = urls.sort((a,b)=>a.sort_order-b.sort_order);
  }
  const parsed = generationViewSchema.safeParse({
    session_id: sessionId, state, requested_question_count: parsedSession.data.requested_question_count,
    answer_editable:state==="completed" && answerEditable,
    followup_enabled:followupAccess.enabled,
    readability_improved:true,
    question_actions:capabilities,
    failed_request_id: attempt?.status === "failed" ? attempt.request_id : null,
    questions: state === "completed" ? savedQuestions : [],
    images: state === "completed" ? signedImages : [],
  });
  if (!parsed.success) throw new QuestionGenerationError("QGEN-RECOVERY", 503);
  return parsed.data;
}
