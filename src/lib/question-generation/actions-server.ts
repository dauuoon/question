import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { questionActionCapabilitiesSchema,QuestionActionError } from "./actions-contract";
import {questionRegenerationEnabled} from "../ai/server/question-regeneration-config";

export async function readQuestionActionCapabilities(caller:SupabaseClient,sessionId:string) {
  const result=await caller.rpc("read_question_action_capabilities",{p_session_id:sessionId});
  if(result.error) {
    if(["PGRST202","42883"].includes(result.error.code)) {
      console.warn("WHY BOX question actions: QA-UNAVAILABLE");
      return {ready:false,reserve_count:0,reserve_count_by_question:{},regeneration:undefined};
    }
    throw new QuestionActionError(result.error.code==="42501"?"QA-AUTH":"QA-DB",
      result.error.code==="42501"?403:503);
  }
  const parsed=questionActionCapabilitiesSchema.safeParse(result.data);
  if(!parsed.success)throw new QuestionActionError("QA-DB");
  return {...parsed.data,...(parsed.data.regeneration?{regeneration:{
    ...parsed.data.regeneration,ready:parsed.data.regeneration.ready&&questionRegenerationEnabled(),
  }}:{})};
}
