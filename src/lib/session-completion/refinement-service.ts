import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SENTENCE_REFINEMENT_PROMPT_VERSION } from "@/lib/ai/prompts/sentence-refinement-v1.2";
import { sentenceRefinementConfig } from "@/lib/ai/server/sentence-refinement-config";
import { refineSentence } from "@/lib/ai/server/sentence-refinement";
import { SentenceRefinementError } from "@/lib/ai/sentence-refinement-contract";
import { briefingInputSchema, type BriefingInput } from "./briefing-contract";
import { refinementTargets } from "./refinement-plan";

const claimSchema=z.discriminatedUnion("state",[
  z.object({state:z.literal("claimed"),id:z.number().int().positive()}).strict(),
  z.object({state:z.literal("completed"),result:z.string().trim().min(1)}).strict(),
  z.object({state:z.enum(["running","failed"]),result:z.null()}).strict(),
]);

export async function refineCompletionAnswers(
  trusted:SupabaseClient,participantId:string,requestId:string,input:BriefingInput,
):Promise<BriefingInput> {
  const config=sentenceRefinementConfig();
  async function rpc(name:string,params:Record<string,unknown>) {
    const result=await trusted.rpc(name,params).abortSignal(AbortSignal.timeout(15_000));
    if(result.error)throw new Error(`Completion refinement database error: ${result.error.code}`);
    return result.data as unknown;
  }
  const session=input.session_id;
  const common={p_session_id:session,p_request_id:requestId,p_participant_id:participantId};
  await rpc("completion_refinement_phase",{...common,p_phase:"refining",p_failure_count:0});
  const ids=input.answered_questions.flatMap(q=>[q.question_id,...(q.followup?[q.followup.question_id]:[])]);
  const questions=await trusted.from("questions").select("id,answer_form").in("id",ids)
    .eq("session_id",session).abortSignal(AbortSignal.timeout(15_000));
  if(questions.error)throw new Error(`Completion question lookup failed: ${questions.error.code}`);
  const parsed=z.array(z.object({id:z.uuid(),answer_form:z.unknown()})).safeParse(questions.data);
  if(!parsed.success||parsed.data.length!==ids.length)throw new Error("Completion question metadata is incomplete");
  const kinds:Record<string,"text"|"choice">={};
  for(const question of parsed.data) {
    const form=z.object({kind:z.enum(["numbered","sections","choice"])}).safeParse(question.answer_form);
    if(question.answer_form===null)kinds[question.id]="text";
    else if(form.success)kinds[question.id]=form.data.kind==="choice"?"choice":"text";
    else throw new Error("Invalid completion answer form");
  }
  const targets=refinementTargets(input,kinds);
  const outputs=await Promise.all(targets.map(async target=>{
    const claim=claimSchema.parse(await rpc("claim_completion_refinement",{
      ...common,p_question_id:target.questionId,p_source:target.sourceText,p_source_hash:target.sourceHash,
      p_prompt_version:SENTENCE_REFINEMENT_PROMPT_VERSION,p_model:config.model,
    }));
    if(claim.state==="completed")return {target,text:claim.result};
    if(claim.state!=="claimed")return {target,text:null};
    let text:string|null=null;
    let failure:string|null=null;
    try {
      text=await refineSentence(config,target.sourceText,AbortSignal.timeout(60_000));
    } catch(error) {
      failure=error instanceof SentenceRefinementError?error.code:"REFINE-API";
      console.error("WHY BOX completion refinement failed",{code:failure});
    }
    await rpc("finish_completion_refinement",{...common,p_id:claim.id,p_result:text,p_failure_code:failure});
    return {target,text};
  }));
  const refined=structuredClone(input);
  for(const {target,text} of outputs) {
    if(!text)continue;
    for(const question of refined.answered_questions) {
      const answer=question.question_id===target.questionId?question.answer:
        question.followup?.question_id===target.questionId?question.followup.answer:null;
      if(!answer)continue;
      answer.refined=text;
      answer.current_version="refined";
      answer.selected=text;
      delete answer.choice_selection;
    }
  }
  const valid=briefingInputSchema.parse(refined);
  await rpc("completion_refinement_phase",{...common,p_phase:"briefing",
    p_failure_count:outputs.filter(output=>output.text===null).length});
  return valid;
}
