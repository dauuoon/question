import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { existsSync } from "node:fs";
import { join } from "node:path";

export async function GET() {
  const env=getServerEnv();
  const ref=new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  const regenerationDisabled=process.env.OPENAI_QUESTION_REGENERATION_ENABLED==="false"&&
    !process.env.OPENAI_QUESTION_REGENERATION_MODEL;
  const aiDisabled=regenerationDisabled&&!process.env.OPENAI_API_KEY&&
    process.env.OPENAI_SENTENCE_REFINEMENT_ENABLED==="false"&&
    process.env.OPENAI_CONTEXT_DRAFT_ENABLED==="false"&&
    !process.env.OPENAI_QUESTION_GENERATION_MODEL;
  const researcher=process.env.NODE_ENV!=="production"&&
    process.env.WHY_BOX_RESEARCHER_REFINEMENT==="approved"&&
    !!process.env.WHY_BOX_RESEARCHER_PARTICIPANT&&!!process.env.WHY_BOX_RESEARCHER_SESSION&&
    !!process.env.WHY_BOX_RESEARCHER_BUDGET&&process.env.SESSION_BRIEFING_MOCK_ENABLED==="true";
  const refinementOnly=process.env.NODE_ENV!=="production"&&regenerationDisabled&&process.env.OPENAI_SENTENCE_REFINEMENT_ENABLED==="true"&&
    process.env.OPENAI_SENTENCE_REFINEMENT_MODEL==="gpt-6-astra"&&
    (!!process.env.WHY_BOX_TEST_REFINEMENT_BUDGET||researcher)&&
    process.env.OPENAI_CONTEXT_DRAFT_ENABLED==="false"&&!process.env.OPENAI_QUESTION_GENERATION_MODEL;
  if(ref!=="njtgxnlxlhxpbiekbgmv"||(!aiDisabled&&!refinementOnly)) {
    console.error("TEST runtime isolation guard failed");
    return NextResponse.json({error:"TEST isolation failed"},{status:503});
  }
  return NextResponse.json({
    projectRef:ref,storageHost:new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname,
    refinementEnabled:refinementOnly,allAIDisabled:aiDisabled,
    refinementCallLimit:refinementOnly?(researcher?3:1):0,otherAIDisabled:true,
    researcherMode:researcher,
    refinementCallsRemaining:researcher?Array.from({length:3},(_,i)=>i+1).filter(slot=>
      !existsSync(join(process.env.WHY_BOX_RESEARCHER_BUDGET!,`call-${slot}`))).length:0,
    authCookiePrefix:`sb-${ref}-auth-token`,
  },{headers:{"Cache-Control":"no-store"}});
}
