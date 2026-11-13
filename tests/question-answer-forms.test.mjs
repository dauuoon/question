import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { typescriptLoader } from "./helpers/typescript-loader.mjs";
import { PGlite } from "@electric-sql/pglite";
import { pgliteFixture, initialize, populate, auth, owner, quote, beginSQL, commitSQL, candidate, generatedAt } from "./question-regeneration-fixture.mjs";

const load=typescriptLoader();
const { answerFormSchema, answerFieldsText, answerFieldsMatchForm }=load("src/lib/answers/form.ts");
const numbered={kind:"numbered",title:"확인할 기준 세 가지",labels:["항목 1","항목 2","항목 3"]};
const sections={kind:"sections",title:"시안별 생각",labels:["시안 1","시안 2"]};
const choice={kind:"choice",title:"비교할 부분",labels:["겹친 부분의 색","도형의 경계","직접 입력","짧은 설명"],
  max_selections:2,explanation_prompt:"어떤 차이를 확인하고 싶나요?"};

test("previous prompt schemas cannot persist a choice form",async t=>{
  const db=new PGlite(); t.after(()=>db.close());
  const exec=sql=>db.exec(sql);
  const json=async sql=>(await db.exec(sql)).at(-1).rows[0].result;
  await initialize(exec,true);
  await assert.rejects(populate(exec,json,3,[choice],"question-generation-v2.12"),/Choice form requires choice schema/);
});

test("choice answers store only selected values, other input and explanation in distinct fields",async t=>{
  assert.equal(answerFormSchema.safeParse(choice).success,true);
  assert.equal(answerFieldsMatchForm(choice,["겹친 부분의 색","","","차이 확인"]),true);
  assert.equal(answerFieldsMatchForm(choice,["잘못된 선택","","",""]),false);
  assert.equal(answerFieldsMatchForm(choice,["겹친 부분의 색","도형의 경계","직접 쓴 항목",""]),false);
  const f=await pgliteFixture(3,[choice],"question-generation-v2.13");t.after(()=>f.close());
  const id=f.questions[0].id;
  await f.exec(`${auth("authenticated")} insert into answers(question_id,participant_id,original_answer,original_answer_fields)
    values(${quote(id)},${quote(owner)},'겹친 부분의 색'||E'\\n\\n'||'어떻게 보이는지',
      array['겹친 부분의 색','','','어떻게 보이는지']);`);
  const answer=(await f.db.query("select original_answer,original_answer_fields from answers where question_id=$1",[id])).rows[0];
  assert.deepEqual(answer.original_answer_fields,["겹친 부분의 색","","","어떻게 보이는지"]);
  assert.doesNotMatch(answer.original_answer,/도형의 경계|직접 입력|짧은 설명/);
  await assert.rejects(f.exec(`${auth("authenticated")} update answers set original_answer='잘못된 선택',
    original_answer_fields=array['잘못된 선택','','',''] where question_id=${quote(id)}`),/Invalid selected option/);
  await assert.rejects(f.exec(`${auth("authenticated")} update answers set original_answer='겹친 부분의 색'||E'\\n\\n'||'도형의 경계'||E'\\n\\n'||'직접 쓴 항목',
    original_answer_fields=array['겹친 부분의 색','도형의 경계','직접 쓴 항목',''] where question_id=${quote(id)}`),/Too many selected options/);
  for(const [text,fields,status] of [
    ["설명만",["","","","설명만"],"answered"],
    ["직접 쓴 항목",["","","직접 쓴 항목",""],"answered"],
    ["",["","","",""],"unprocessed"],
  ]){
    await f.exec(`${auth("authenticated")} update answers set original_answer=${quote(text)},
      original_answer_fields=array[${fields.map(quote).join(",")}] where question_id=${quote(id)}`);
    assert.equal((await f.db.query("select status from questions where id=$1",[id])).rows[0].status,status);
  }
});

test("form contract limits labels and keeps only user content, not titles or numbers",()=>{
  assert.deepEqual(answerFormSchema.parse(numbered),numbered);
  for(const form of [
    {...numbered,labels:["항목 1"]},{...numbered,labels:["중복","중복"]},
    {...numbered,title:""},{...numbered,answer:"미리 제시한 답변"},
    {...choice,labels:["같음","같음","직접 입력","짧은 설명"]},
    {...choice,max_selections:4},{...choice,explanation_prompt:""},
    {...choice,labels:["색","경계","기타","설명"]},
  ])assert.equal(answerFormSchema.safeParse(form).success,false);
  assert.equal(answerFieldsText(["","",""]),"");
  assert.equal(answerFieldsText(["첫 기준","","세 번째 기준"]),"첫 기준\n\n세 번째 기준");
  assert.equal(answerFieldsText(["여러 줄\n내용","다른 내용"]),"여러 줄\n내용\n\n다른 내용");
});

test("follow-up output requires a form field and no-follow-up cannot carry a form",()=>{
  const {questionFollowupOutputSchema,QUESTION_FOLLOWUP_SCHEMA}=load("src/lib/ai/question-followup-contract.ts");
  assert.ok(QUESTION_FOLLOWUP_SCHEMA.schema.required.includes("answer_form"));
  assert.equal(questionFollowupOutputSchema.safeParse({
    outcome:"generated",followup_question:"두 시안을 각각 검토한다면?",answer_form:sections,
  }).success,true);
  for(const output of [
    {outcome:"generated",followup_question:"질문"},
    {outcome:"no_followup",followup_question:null,answer_form:sections},
  ])assert.equal(questionFollowupOutputSchema.safeParse(output).success,false);
});

test("missing form-storage readiness stops both repositories before image access or provider dispatch",async()=>{
  const caller={rpc(name,parameters){
    assert.equal(name,"choice_answer_history_access_ready");
    assert.deepEqual(parameters,{});
    return {abortSignal:async()=>({data:null,error:{code:"PGRST202"}})};
  },from(){throw new Error("Unexpected DB row read");},storage:{from(){throw new Error("Unexpected image signing");}}};
  const {createGenerationRepository}=load("src/lib/ai/server/question-generation-service.ts");
  const {createRegenerationRepository}=load("src/lib/question-generation/regeneration-repository.ts");
  for(const [repository,code] of [
    [createGenerationRepository(caller,{},owner),"QGEN-DB"],
    [createRegenerationRepository(caller,{},owner),"QA-UNAVAILABLE"],
  ])await assert.rejects(repository.images({image_snapshot:[]},globalThis.AbortSignal.timeout(1000)),error=>
    error.code===code||error.errorCode===code);
});

test("initial candidates and Reserve retain immutable form metadata with correct prompt/schema versions",async t=>{
  const f=await pgliteFixture(3,[null,numbered,sections,numbered]);t.after(()=>f.close());
  const rows=(await f.db.query("select answer_form,prompt_version,schema_version from question_candidates order by candidate_rank")).rows;
  assert.deepEqual(rows.map(row=>row.answer_form),[null,numbered,sections,numbered,null]);
  assert.ok(rows.every(row=>row.prompt_version==="question-generation-v2.8"&&row.schema_version==="why_box_question_generation_v2_1"));
  assert.deepEqual(f.questions.map(question=>question.answer_form),[null,numbered,sections]);
  await assert.rejects(f.exec(`update questions set answer_form=null where id=${quote(f.questions[1].id)}`),/immutable/);
  const changed=await f.json(`${auth()} select public.apply_question_action(${quote(f.session)},${quote(f.questions[0].id)},
    ${quote(randomUUID())},'regenerate',${quote(owner)},null) as result;`);
  const replacement=(await f.db.query("select answer_form from questions where id=$1",[changed.result_question_id])).rows[0];
  assert.deepEqual(replacement.answer_form,numbered);
});

test("DB accepts only user fields with matching form and protects saved answers, empty forms stay unprocessed",async t=>{
  const f=await pgliteFixture(5,[numbered]);t.after(()=>f.close());
  const id=f.questions[0].id;
  const insert=(fields,text)=>`${auth("authenticated")} insert into answers(question_id,participant_id,original_answer,original_answer_fields)
    values(${quote(id)},${quote(owner)},${quote(text)},array[${fields.map(quote).join(",")}]);`;
  await f.exec(insert(["","",""],""));
  assert.equal((await f.db.query("select status from questions where id=$1",[id])).rows[0].status,"unprocessed");
  await f.exec(`${auth("authenticated")} update answers set original_answer_fields=array[${quote("\u00a0")},${quote("\ufeff")} ,'']
    where question_id=${quote(id)}`);
  assert.equal((await f.db.query("select status from questions where id=$1",[id])).rows[0].status,"unprocessed");
  await assert.rejects(f.exec(`${auth("authenticated")} update answers set original_answer='1. 미리 입력된 번호',
    original_answer_fields=array['실제 내용','',''] where question_id=${quote(id)}`),/only user field/);
  await f.exec(`${auth("authenticated")} update answers set original_answer='실제 내용',
    original_answer_fields=array['실제 내용','',''] where question_id=${quote(id)}`);
  const saved=(await f.db.query("select original_answer,original_answer_fields from answers where question_id=$1",[id])).rows[0];
  assert.equal(saved.original_answer,"실제 내용");
  assert.deepEqual(saved.original_answer_fields,["실제 내용","",""]);
  assert.equal((await f.db.query("select status from questions where id=$1",[id])).rows[0].status,"answered");
  await assert.rejects(f.exec(`${auth("authenticated")} update answers set original_answer_fields=array['실제 내용',''] where question_id=${quote(id)}`),/do not match/);
});

for(const version of ["question-regeneration-v1.3","question-regeneration-v1.4","question-regeneration-v1.5","question-regeneration-v1.6","question-regeneration-v1.7","question-regeneration-v1.8"])
test(`API-generated replacement ${version} stores the new form without changing dispatch budgets`,async t=>{
  const f=await pgliteFixture();t.after(()=>f.close());
  const begun=await f.json(beginSQL(f));
  const schema=version.endsWith("v1.8")?"why_box_question_regeneration_v1_2":"why_box_question_regeneration_v1_1";
  const form=version.endsWith("v1.8")?choice:sections;
  await f.exec(`${auth()} select public.authorize_question_regeneration_dispatch(
    ${quote(begun.attempt_id)},${quote(begun.request_id)},${quote(owner)},'LOCAL-MOCK',
    ${quote(version)},${quote(schema)});`);
  const payload={...candidate(),answer_form:form,answer_guides:[]};
  await f.exec(`${auth()} select public.stage_question_regeneration_candidate(
    ${quote(begun.attempt_id)},${quote(begun.request_id)},${quote(owner)},${quote(JSON.stringify(payload))}::jsonb,
    'LOCAL-MOCK',${quote(version)},${quote(schema)},'v1.0',${quote(generatedAt)});`);
  const committed=await f.json(commitSQL(begun));
  const question=(await f.db.query("select answer_form from questions where id=$1",[committed.result_question_id])).rows[0];
  assert.deepEqual(question.answer_form,form);
});

for(const version of ["question-followup-v1.3","question-followup-v1.4","question-followup-v1.5","question-followup-v1.6","question-followup-v1.7","question-followup-v1.8"])
test(`answer-based follow-up ${version} stores a separate form, schema and answer while locking the parent`,async t=>{
  const f=await pgliteFixture();t.after(()=>f.close());
  const form=version.endsWith("v1.8")?choice:sections;
  const parent=f.questions[0],text="자신의 판단을 돌아보는 합성 답변";
  await f.exec(`${auth()} update sessions set status='in_progress' where id=${quote(f.session)};`);
  await f.exec(`${auth("authenticated")} insert into answers(question_id,participant_id,original_answer)
    values(${quote(parent.id)},${quote(owner)},${quote(text)});`);
  const revision=(await f.db.query("select updated_at::text revision from answers where question_id=$1",[parent.id])).rows[0].revision;
  const request=await f.json(`${auth()} select public.begin_question_followup(${quote(f.session)},${quote(parent.id)},
    ${quote(randomUUID())},${quote(owner)},${quote(revision)},${quote(createHash("sha256").update(text).digest("hex"))},
    ${quote(text)},${quote(version)}) as result;`);
  await f.exec(`${auth()} select public.dispatch_question_followup(${quote(request.id)},'LOCAL-MOCK');`);
  const finished=await f.json(`${auth()} select public.finish_question_followup(${quote(request.id)},'generated',
    '두 시안을 각각 검토하면 어떤 생각이 드나요?','LOCAL-MOCK',10,20,null,${quote(JSON.stringify(form))}::jsonb) as result;`);
  const child=(await f.db.query("select answer_form from questions where id=$1",[finished.result_question_id])).rows[0];
  assert.deepEqual(child.answer_form,form);
  const record=(await f.db.query("select prompt_version,schema_version from question_followup_requests where id=$1",[request.id])).rows[0];
  assert.deepEqual(record,{prompt_version:version,schema_version:version.endsWith("v1.8")?
    "why_box_question_followup_v1_2":"why_box_question_followup_v1_1"});
  await assert.rejects(f.exec(`${auth("authenticated")} update answers set original_answer='변경' where question_id=${quote(parent.id)}`),/read-only|locked/);
});
