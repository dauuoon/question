import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { pgliteFixture, populate, auth, quote, owner, other, beginSQL, candidate, generatedAt, commitSQL } from "./question-regeneration-fixture.mjs";
import { typescriptLoader } from "./helpers/typescript-loader.mjs";

const migration=readFileSync(new URL("../supabase/migrations/20261113070000_single_choice_answers.sql",import.meta.url),"utf8");
const historyAccess=readFileSync(new URL("../supabase/migrations/20261113080000_choice_answer_history_access.sql",import.meta.url),"utf8");
const form={kind:"choice",title:"비교",labels:["색","경계","직접 입력","짧은 설명"],
  max_selections:2,explanation_prompt:"확인할 부분은?"};

test("new prompt and schema versions support generation, replacement and follow-up",async t=>{
  const f=await pgliteFixture(5);t.after(()=>f.close());
  await f.exec(migration);
  await f.exec(historyAccess);
  const single={...form,max_selections:1};
  await assert.rejects(populate(f.exec,f.json,3,[form],"question-generation-v2.14"),/Single choice form required/);
  const newer=await populate(f.exec,f.json,3,[single],"question-generation-v2.14");
  await assert.rejects(f.exec(`update question_candidates set schema_version='why_box_question_generation_v2_2'
    where session_id=${quote(newer.session)}`),/immutable|constraint/);
  assert.deepEqual(newer.questions[0].answer_form,single);
  const begun=await f.json(beginSQL(f));
  await f.exec(`${auth()} select public.authorize_question_regeneration_dispatch(
    ${quote(begun.attempt_id)},${quote(begun.request_id)},${quote(owner)},'LOCAL-MOCK',
    'question-regeneration-v1.9','why_box_question_regeneration_v1_3');`);
  const replacement={...candidate(),answer_form:single,answer_guides:[]};
  await f.exec(`${auth()} select public.stage_question_regeneration_candidate(
    ${quote(begun.attempt_id)},${quote(begun.request_id)},${quote(owner)},${quote(JSON.stringify(replacement))}::jsonb,
    'LOCAL-MOCK','question-regeneration-v1.9','why_box_question_regeneration_v1_3','v1.0',${quote(generatedAt)});`);
  const committed=await f.json(commitSQL(begun));
  assert.deepEqual((await f.db.query("select answer_form from questions where id=$1",[committed.result_question_id])).rows[0].answer_form,single);
  const parent=newer.questions[1],text="작성한 생각";
  await f.exec(`${auth("authenticated")} insert into answers(question_id,participant_id,original_answer)
    values(${quote(parent.id)},${quote(owner)},${quote(text)});`);
  const revision=(await f.db.query("select updated_at::text revision from answers where question_id=$1",[parent.id])).rows[0].revision;
  const req=await f.json(`${auth()} select public.begin_question_followup(${quote(newer.session)},${quote(parent.id)},
    ${quote(randomUUID())},${quote(owner)},${quote(revision)},${quote(createHash("sha256").update(text).digest("hex"))},
    ${quote(text)},'question-followup-v1.9') as result;`);
  await f.exec(`${auth()} select public.dispatch_question_followup(${quote(req.id)},'LOCAL-MOCK');`);
  const done=await f.json(`${auth()} select public.finish_question_followup(${quote(req.id)},'generated',
    '무엇을 확인하나요?','LOCAL-MOCK',10,20,null,${quote(JSON.stringify(single))}::jsonb) as result;`);
  assert.deepEqual((await f.db.query("select answer_form from questions where id=$1",[done.result_question_id])).rows[0].answer_form,single);
  assert.equal((await f.db.query("select schema_version from question_followup_requests where id=$1",[req.id])).rows[0].schema_version,
    "why_box_question_followup_v1_3");
});

test("single-choice edits archive the previous answer and validate atomically",async t=>{
  const f=await pgliteFixture(3,[form],"question-generation-v2.13");t.after(()=>f.close());
  const id=f.questions[0].id;
  await f.exec(`${auth("authenticated")} insert into answers(question_id,participant_id,original_answer,original_answer_fields)
    values(${quote(id)},${quote(owner)},'색'||E'\\n\\n'||'경계'||E'\\n\\n'||'기존 설명',array['색','경계','','기존 설명']);`);
  await f.exec(migration);
  await f.exec(historyAccess);
  const original=await f.json(`select to_jsonb(a) as result from answers a where question_id=${quote(id)}`);
  const change=(text,fields)=>`${auth("authenticated")} update answers set original_answer=${quote(text)},
    original_answer_fields=array[${fields.map(quote).join(",")}] where question_id=${quote(id)};`;
  await assert.rejects(f.exec(change("색\n\n경계",["색","경계","",""])),/only one selection/);
  assert.deepEqual(await f.json(`select to_jsonb(a) as result from answers a where question_id=${quote(id)}`),original);
  assert.equal((await f.db.query("select count(*)::int n from choice_answer_history")).rows[0].n,0);
  await assert.rejects(f.exec(change("색\n\n설명",["색","","","설명"])),/cannot contain an explanation/);
  await f.exec(change("색",["색","","",""]));
  const history=await f.json(`${auth("authenticated")} select to_jsonb(h) as result from choice_answer_history h`);
  assert.equal(history.original_answer,original.original_answer);
  assert.deepEqual(history.original_answer_fields,original.original_answer_fields);
  assert.equal((await f.db.query("select count(*)::int n from choice_answer_history")).rows[0].n,1);
  const foreign=await f.json(`${auth("authenticated",other)} select coalesce(jsonb_agg(h),'[]'::jsonb) as result from choice_answer_history h`);
  assert.deepEqual(foreign,[]);
  await f.exec(`update public.profiles set status='deactivated' where id=${quote(owner)}`);
  const inactive=await f.json(`${auth("authenticated")} select coalesce(jsonb_agg(h),'[]'::jsonb) as result from choice_answer_history h`);
  assert.deepEqual(inactive,[]);
  await f.exec(`update public.profiles set status='active' where id=${quote(owner)}`);
  await f.exec(change("",["","","",""]));
  assert.equal((await f.db.query("select status from questions where id=$1",[id])).rows[0].status,"unprocessed");
  await f.exec(change("직접 작성",["","","직접 작성",""]));
  assert.equal((await f.db.query("select status from questions where id=$1",[id])).rows[0].status,"answered");
  const helper=typescriptLoader()("src/lib/answers/form.ts");
  assert.equal(helper.newAnswerFieldsMatchForm(form,["색","","",""]),true);
  assert.equal(helper.newAnswerFieldsMatchForm(form,["","","직접 작성",""]),true);
  assert.equal(helper.newAnswerFieldsMatchForm(form,["색","경계","",""]),false);
  assert.equal(helper.newAnswerFieldsMatchForm(form,["색","","","설명"]),false);
});

for (const [text,fields,expected] of [
  ["색",["색","","",""],{selected_options:["색"],other:"",explanation:""}],
  ["직접 작성",["","","직접 작성",""],{selected_options:[],other:"직접 작성",explanation:""}],
]) test(`single-choice ${text} reaches briefing snapshot`,async t=>{
  const f=await pgliteFixture(3,[form],"question-generation-v2.13");t.after(()=>f.close());
  for(const name of ["20261010003000_session_completion_briefing.sql","20261023000000_briefing_followup_snapshot.sql",
    "20261113060000_briefing_choice_snapshot.sql","20261113070000_single_choice_answers.sql"])
    await f.exec(readFileSync(new URL(`../supabase/migrations/${name}`,import.meta.url),"utf8"));
  await f.exec(`${auth("authenticated")} insert into answers(question_id,participant_id,original_answer,original_answer_fields)
    values(${quote(f.questions[0].id)},${quote(owner)},${quote(text)},array[${fields.map(quote).join(",")}]);`);
  for(const q of f.questions.slice(1)) await f.json(`${auth()} select public.apply_question_action(
    ${quote(f.session)},${quote(q.id)},${quote(randomUUID())},'skip',${quote(owner)},null) as result;`);
  const begun=await f.json(`${auth("authenticated")} select public.begin_session_completion(
    ${quote(f.session)},${quote(randomUUID())},null) as result;`);
  assert.deepEqual(begun.input_snapshot.answered_questions[0].answer.choice_selection,expected);
  const provider=typescriptLoader()("src/lib/ai/server/session-briefing-provider.ts");
  const payload=JSON.parse(provider.sessionBriefingParameters("test-model",begun.input_snapshot).input[0].content[0].text);
  assert.equal(payload.final_answers[0].answer,text);
  assert.doesNotMatch(JSON.stringify(payload),/경계|임시 초안/);
});
