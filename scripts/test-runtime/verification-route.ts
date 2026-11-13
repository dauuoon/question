import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { QUESTION_GENERATION_PROMPT_VERSION } from "@/lib/ai/prompts/question-generation-v2.15";
import { QUESTION_GENERATION_SCHEMA } from "@/lib/ai/schemas/question-generation-v2.3";

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
  const liveBriefing=process.env.WHY_BOX_TEST_LIVE_BRIEFING==="enabled"&&
    process.env.OPENAI_SESSION_BRIEFING_ENABLED==="true"&&
    process.env.OPENAI_SESSION_BRIEFING_MODEL===process.env.OPENAI_QUESTION_GENERATION_MODEL&&
    process.env.OPENAI_COMPLETION_REFINEMENT_ENABLED==="true"&&
    process.env.OPENAI_SENTENCE_REFINEMENT_ENABLED==="true"&&
    process.env.OPENAI_SENTENCE_REFINEMENT_MODEL===process.env.OPENAI_QUESTION_GENERATION_MODEL&&
    process.env.SESSION_BRIEFING_MOCK_ENABLED==="false";
  const mockBriefing=process.env.OPENAI_SESSION_BRIEFING_ENABLED==="false"&&
    !process.env.OPENAI_SESSION_BRIEFING_MODEL&&process.env.SESSION_BRIEFING_MOCK_ENABLED==="true"&&
    !process.env.WHY_BOX_TEST_LIVE_BRIEFING;
  const questionGenerationOnly=process.env.NODE_ENV==="development"&&regenerationDisabled&&
    process.env.WHY_BOX_TEST_QUESTION_GENERATION==="enabled"&&!!process.env.OPENAI_API_KEY&&
    !!process.env.OPENAI_QUESTION_GENERATION_MODEL&&process.env.OPENAI_CONTEXT_DRAFT_ENABLED==="false"&&
    !process.env.OPENAI_CONTEXT_DRAFT_MODEL&&
    (liveBriefing||(process.env.OPENAI_SENTENCE_REFINEMENT_ENABLED==="false"&&!process.env.OPENAI_SENTENCE_REFINEMENT_MODEL))&&
    process.env.OPENAI_QUESTION_FOLLOWUP_ENABLED==="false"&&
    !process.env.OPENAI_QUESTION_FOLLOWUP_MODEL&&(liveBriefing||mockBriefing);
  if(ref!=="njtgxnlxlhxpbiekbgmv"||(!aiDisabled&&!refinementOnly&&!questionGenerationOnly)) {
    console.error("TEST runtime isolation guard failed");
    return NextResponse.json({error:"TEST isolation failed"},{status:503});
  }
  return NextResponse.json({
    projectRef:ref,storageHost:new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname,
    refinementEnabled:refinementOnly||liveBriefing,allAIDisabled:aiDisabled,
    questionGenerationEnabled:questionGenerationOnly,
    questionModel:questionGenerationOnly?process.env.OPENAI_QUESTION_GENERATION_MODEL:null,
    questionPromptVersion:questionGenerationOnly?QUESTION_GENERATION_PROMPT_VERSION:null,
    questionSchemaVersion:questionGenerationOnly?QUESTION_GENERATION_SCHEMA.name:null,
    briefingMode:questionGenerationOnly&&liveBriefing?"openai":"mock",
    briefingModel:questionGenerationOnly&&liveBriefing?process.env.OPENAI_SESSION_BRIEFING_MODEL:null,
    automaticRefinementEnabled:questionGenerationOnly&&liveBriefing,
    refinementCallLimit:liveBriefing?null:refinementOnly?(researcher?3:1):0,otherAIDisabled:!liveBriefing,
    researcherMode:researcher,
    refinementCallsRemaining:researcher?Array.from({length:3},(_,i)=>i+1).filter(slot=>
      !existsSync(join(process.env.WHY_BOX_RESEARCHER_BUDGET!,`call-${slot}`))).length:0,
    authCookiePrefix:`sb-${ref}-auth-token`,
  },{headers:{"Cache-Control":"no-store"}});
}
