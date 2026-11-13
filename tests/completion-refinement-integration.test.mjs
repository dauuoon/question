import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {pgliteFixture,owner,auth,quote,answerSQL} from "./question-regeneration-fixture.mjs";
import {typescriptLoader} from "./helpers/typescript-loader.mjs";

test("mock completion freezes answers, refines once and reuses result on briefing retry",async t=>{
  const f=await pgliteFixture(3);t.after(()=>f.close());
  for(const name of ["20261010003000_session_completion_briefing.sql","20261023000000_briefing_followup_snapshot.sql",
    "20261113060000_briefing_choice_snapshot.sql","20261113070000_single_choice_answers.sql",
    "20261113080000_choice_answer_history_access.sql","20261114010000_completion_refinement.sql"]) {
    await f.exec(readFileSync(new URL(`../supabase/migrations/${name}`,import.meta.url),"utf8"));
  }
  await f.exec(answerSQL(f.questions[0],"원래 답변"));
  for(const q of f.questions.slice(1))await f.json(`${auth()} select public.apply_question_action(
    ${quote(f.session)},${quote(q.id)},${quote(randomUUID())},'skip',${quote(owner)},null) as result`);
  const rpcSQL=(name,p)=>`${auth()} select public.${name}(${(name==="finish_completion_refinement"?
    [p.p_id,p.p_session_id,p.p_request_id,p.p_participant_id,p.p_result,p.p_failure_code]:Object.values(p)).map(v=>
    typeof v==="number"?String(v):quote(v)).join(",")}) as result`;
  const trusted={
    from(){return {select(){return this;},in(){return this;},eq(){return this;},
      abortSignal:async()=>({data:[{id:f.questions[0].id,answer_form:null}],error:null})};},
    rpc(name,p){return {abortSignal:async()=>{
      try{return {data:await f.json(rpcSQL(name,p)),error:null};}
      catch(error){return {data:null,error:{code:error.code??"DB"}};}
    }};},
  };
  let refinementCalls=0,briefingCalls=0;
  const load=typescriptLoader({
    "@/lib/ai/server/sentence-refinement-config":{sentenceRefinementConfig:()=>({apiKey:"mock",model:"MOCK"})},
    "@/lib/ai/server/sentence-refinement":{refineSentence:async()=>{refinementCalls++;return "정리된 답변";}},
  });
  const {refineCompletionAnswers}=load("src/lib/session-completion/refinement-service.ts");
  const {runSessionBriefing,SessionBriefingProviderError}=load("src/lib/ai/server/session-briefing-service.ts");
  const repo={
    begin:({session_id,request_id,retry_of_request_id})=>f.json(`${auth("authenticated")} select public.begin_session_completion(
      ${quote(session_id)},${quote(request_id)},${quote(retry_of_request_id)}) as result`),
    read:(session,id)=>f.json(`${auth("authenticated")} select public.read_session_briefing_request(${quote(session)},${quote(id)}) as result`),
    dispatch:(session,id)=>f.json(`${auth()} select public.authorize_session_briefing_dispatch(${quote(session)},${quote(id)},${quote(owner)}) as result`),
    fail:p=>f.json(`${auth()} select public.fail_session_briefing(${quote(p.session_id)},${quote(p.request_id)},
      ${quote(owner)},${quote(p.failure_code)},${p.outcome_unknown}) as result`),
    complete:p=>f.json(`${auth()} select public.finish_session_briefing(${quote(p.session_id)},${quote(p.request_id)},
      ${quote(owner)},${quote(p.briefing_text)},${quote(p.model_id)},${quote(p.prompt_version)},${quote(p.schema_version)}) as result`),
  };
  const provider={generate:async snapshot=>{
    briefingCalls++;
    assert.equal(snapshot.answered_questions[0].answer.selected,"정리된 답변");
    if(briefingCalls===1)throw new SessionBriefingProviderError("BRIEFING-API",false);
    return {response:{briefing_text:"정리된 브리핑"},model_id:"MOCK"};
  }};
  const id=randomUUID(),retry=randomUUID();
  const prepare=snapshot=>refineCompletionAnswers(trusted,owner,
    currentId,snapshot);
  let currentId=id;
  assert.equal((await runSessionBriefing(repo,provider,{session_id:f.session,request_id:id},prepare)).state,"failed");
  currentId=retry;
  assert.equal((await runSessionBriefing(repo,provider,{session_id:f.session,request_id:retry,retry_of_request_id:id},prepare)).state,"completed");
  assert.equal((await runSessionBriefing(repo,provider,{session_id:f.session,request_id:retry},prepare)).state,"completed");
  assert.equal(refinementCalls,1);assert.equal(briefingCalls,2);
  const answer=(await f.db.query("select original_answer,refined_answer from answers where question_id=$1",[f.questions[0].id])).rows[0];
  assert.deepEqual(answer,{original_answer:"원래 답변",refined_answer:null});
  assert.equal((await f.db.query("select count(*)::int n from answer_refinement_history where mode='automatic'")).rows[0].n,1);
});
