import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash,randomUUID} from "node:crypto";
import {pgliteFixture,populate,owner,auth,quote,answerSQL,beginSQL,candidate,generatedAt} from "./question-regeneration-fixture.mjs";

const migration=name=>readFileSync(new URL(`../supabase/migrations/${name}`,import.meta.url),"utf8");
const hash=text=>createHash("sha256").update(text).digest("hex");

test("completion refinement claims once, records failure, reuses result and preserves saved answer",async t=>{
  const f=await pgliteFixture(3);t.after(()=>f.close());
  for(const name of ["20261010003000_session_completion_briefing.sql","20261023000000_briefing_followup_snapshot.sql",
    "20261113060000_briefing_choice_snapshot.sql","20261113070000_single_choice_answers.sql",
    "20261113080000_choice_answer_history_access.sql","20261114010000_completion_refinement.sql",
    "20261114020000_function_understanding_versions.sql"])await f.exec(migration(name));
  const form={kind:"choice",title:"비교",labels:["색","경계","직접 입력","짧은 설명"],
    max_selections:1,explanation_prompt:"직접 적어주세요"};
  const fresh=await populate(f.exec,f.json,5,[form],"question-generation-v2.15");
  assert.equal(fresh.questions[0].answer_form.max_selections,1);
  const regeneration=await f.json(beginSQL({...f,...fresh}));
  await f.exec(`${auth()} select public.authorize_question_regeneration_dispatch(
    ${quote(regeneration.attempt_id)},${quote(regeneration.request_id)},${quote(owner)},'MOCK',
    'question-regeneration-v1.10','why_box_question_regeneration_v1_3')`);
  const replacement={...candidate(),answer_form:form,answer_guides:[]};
  await f.exec(`${auth()} select public.stage_question_regeneration_candidate(
    ${quote(regeneration.attempt_id)},${quote(regeneration.request_id)},${quote(owner)},
    ${quote(JSON.stringify(replacement))}::jsonb,'MOCK','question-regeneration-v1.10',
    'why_box_question_regeneration_v1_3','v1.0',${quote(generatedAt)})`);
  const manualQuestion=fresh.questions[1].id;
  await f.exec(answerSQL(fresh.questions[1],"수동 원문"));
  const revision=(await f.db.query("select updated_at::text from answers where question_id=$1",[manualQuestion])).rows[0].updated_at;
  const manual=await f.json(`${auth()} select public.save_manual_answer_refinement(
    ${quote(manualQuestion)},${quote(owner)},${quote(revision)},'수동 원문','수동 결과',
    'sentence-refinement-v1.2','MOCK') as result`);
  assert.ok(manual.updated_at);
  const savedManual=(await f.db.query("select mode,prompt_version,model_id,source_text,result_text from answer_refinement_history where question_id=$1",[manualQuestion])).rows[0];
  assert.deepEqual(savedManual,{mode:"manual",prompt_version:"sentence-refinement-v1.2",model_id:"MOCK",
    source_text:"수동 원문",result_text:"수동 결과"});
  const followupQuestion=fresh.questions[2];
  await f.exec(answerSQL(followupQuestion,"후속 원문"));
  const followupRevision=(await f.db.query("select updated_at::text from answers where question_id=$1",[followupQuestion.id])).rows[0].updated_at;
  const followup=await f.json(`${auth()} select public.begin_question_followup(${quote(fresh.session)},${quote(followupQuestion.id)},
    ${quote(randomUUID())},${quote(owner)},${quote(followupRevision)},${quote(hash("후속 원문"))},
    '후속 원문','question-followup-v1.10') as result`);
  await f.exec(`${auth()} select public.dispatch_question_followup(${quote(followup.id)},'MOCK')`);
  const child=await f.json(`${auth()} select public.finish_question_followup(${quote(followup.id)},'generated',
    '무엇인가요?','MOCK',10,20,null,${quote(JSON.stringify(form))}::jsonb) as result`);
  assert.ok(child.result_question_id);
  const original="작성한 원문";
  await f.exec(answerSQL(f.questions[0],original));
  for(const q of f.questions.slice(1))await f.json(`${auth()} select public.apply_question_action(
    ${quote(f.session)},${quote(q.id)},${quote(randomUUID())},'skip',${quote(owner)},null) as result`);
  const request=randomUUID();
  await f.json(`${auth("authenticated")} select public.begin_session_completion(${quote(f.session)},${quote(request)},null) as result`);
  await f.json(`${auth()} select public.authorize_session_briefing_dispatch(${quote(f.session)},${quote(request)},${quote(owner)}) as result`);
  const args=`${quote(f.session)},${quote(request)},${quote(owner)},${quote(f.questions[0].id)},${quote(original)},${quote(hash(original))},'sentence-refinement-v1.2','TEST'`;
  const claim=()=>f.json(`${auth()} select public.claim_completion_refinement(${args}) as result`);
  const first=await claim();assert.equal(first.state,"claimed");
  assert.equal((await claim()).state,"running");
  await f.exec(`${auth()} select public.finish_completion_refinement(${first.id},${quote(f.session)},${quote(request)},${quote(owner)},'다듬은 문장',null)`);
  assert.deepEqual(await claim(),{state:"completed",result:"다듬은 문장"});
  const failedArgs=args.replace("'sentence-refinement-v1.2'","'sentence-refinement-test-failure'");
  const failed=await f.json(`${auth()} select public.claim_completion_refinement(${failedArgs}) as result`);
  await f.exec(`${auth()} select public.finish_completion_refinement(${failed.id},${quote(f.session)},${quote(request)},${quote(owner)},null,'REFINE-API')`);
  assert.deepEqual(await f.json(`${auth()} select public.claim_completion_refinement(${failedArgs}) as result`),
    {state:"failed",result:null});
  const row=(await f.db.query("select original_answer,refined_answer from answers where question_id=$1",[f.questions[0].id])).rows[0];
  assert.deepEqual(row,{original_answer:original,refined_answer:null});
  assert.equal((await f.db.query("select count(*)::int n from answer_refinement_history where mode='automatic'")).rows[0].n,2);
});
