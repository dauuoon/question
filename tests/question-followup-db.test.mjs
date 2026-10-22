import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  pgliteFixture, populate, owner, other, quote, auth, answerSQL, completeSQL, beginSQL as beginRegenerationSQL, read,
} from "./question-regeneration-fixture.mjs";

async function prepareAnsweredQuestion(f, question = f.questions[0], text = "I chose this direction because it supports the main interaction.") {
  await f.exec(answerSQL(question, text));
  await f.exec(`${auth()} update public.sessions set status='in_progress' where id=${quote(f.session)};`);
  const answer = await f.json(`select jsonb_build_object(
    'updated_at',updated_at,'text',case when current_answer_version='refined'
      then coalesce(refined_answer,'') else original_answer end
  ) as result from public.answers where question_id=${quote(question.id)};`);
  return { question, answer };
}

function beginSQL(f, question, answer, requestId = randomUUID(), actor = owner) {
  const hash = createHash("sha256").update(answer.text, "utf8").digest("hex");
  return `${auth()} select public.begin_question_followup(${quote(f.session)},${quote(question.id)},
    ${quote(requestId)},${quote(actor)},${quote(answer.updated_at)},${quote(hash)},
    ${quote(answer.text)},'question-followup-v1.0') as result;`;
}

const dispatchSQL = (id) => `${auth()} select public.dispatch_question_followup(
  ${quote(id)},'WHY-BOX-FOLLOWUP-TEST') as result;`;
const finishSQL = (id, outcome, questionText = null, failureCode = null) => `${auth()}
  select public.finish_question_followup(${quote(id)},${quote(outcome)},${quote(questionText)},
    'WHY-BOX-FOLLOWUP-TEST',120,24,${quote(failureCode)}) as result;`;

test("generated follow-up claims dispatch once, keeps lineage, and locks the original answer", async () => {
  const f = await pgliteFixture();
  try {
    const { question, answer } = await prepareAnsweredQuestion(f);
    const request = await f.json(beginSQL(f, question, answer));
    assert.equal(request.status, "reserved");
    assert.ok(request.id);
    assert.equal((await f.json(dispatchSQL(request.id))).acquired, true);
    assert.equal((await f.json(dispatchSQL(request.id))).acquired, false);

    const result = await f.json(finishSQL(request.id, "generated", "What evidence most influenced that decision?"));
    assert.equal(result.status, "generated");
    const child = await f.json(`select jsonb_build_object(
      'question_kind',q.question_kind,'root_question_id',q.root_question_id,
      'parent_question_id',q.parent_question_id,'followup_index',q.followup_index,
      'target_count',(select count(*) from public.question_targets t where t.question_id=q.id)
    ) as result from public.questions q where q.id=${quote(result.result_question_id)};`);
    assert.deepEqual(child, {
      question_kind: "followup", root_question_id: question.id, parent_question_id: question.id,
      followup_index: 1, target_count: 1,
    });

    await assert.rejects(f.exec(`${auth("authenticated")} update public.answers
      set original_answer='changed' where question_id=${quote(question.id)};`),
    /Answer is locked after follow-up generation/);
    await f.exec(answerSQL({ id: result.result_question_id }, "This is a separate optional answer."));
    const childAnswer = await f.json(`select original_answer as result from public.answers
      where question_id=${quote(result.result_question_id)};`);
    assert.equal(childAnswer, "This is a separate optional answer.");
    const savedRequest = await f.json(`select jsonb_build_object(
      'status',status,'model_id',model_id,'prompt_version',prompt_version,
      'input_tokens',input_tokens,'output_tokens',output_tokens
    ) as result from public.question_followup_requests where id=${quote(request.id)};`);
    assert.deepEqual(savedRequest, {
      status: "generated", model_id: "WHY-BOX-FOLLOWUP-TEST",
      prompt_version: "question-followup-v1.0", input_tokens: 120, output_tokens: 24,
    });
  } finally { await f.close(); }
});

test("no-follow-up is deduplicated by answer content and a changed answer can be retried", async () => {
  const f = await pgliteFixture();
  try {
    const { question, answer } = await prepareAnsweredQuestion(f);
    const first = await f.json(beginSQL(f, question, answer));
    await f.json(dispatchSQL(first.id));
    assert.equal((await f.json(finishSQL(first.id, "no_followup"))).status, "no_followup");

    const sameAnswer = await f.json(beginSQL(f, question, answer));
    assert.equal(sameAnswer.status, "no_followup");
    assert.equal(sameAnswer.request_id, first.request_id);

    await f.exec(`${auth("authenticated")} update public.answers set original_answer='I reconsidered the main interaction after comparing two alternatives.'
      where question_id=${quote(question.id)};`);
    const changedAnswer = await f.json(`select jsonb_build_object(
      'updated_at',updated_at,'text',original_answer
    ) as result from public.answers where question_id=${quote(question.id)};`);
    const second = await f.json(beginSQL(f, question, changedAnswer));
    assert.equal(second.status, "reserved");
    assert.notEqual(second.request_id, first.request_id);
  } finally { await f.close(); }
});

test("RLS isolates requests, child questions and answers while mutation RPCs remain trusted-server only",async()=>{
  const f=await pgliteFixture();
  try {
    const {question,answer}=await prepareAnsweredQuestion(f);
    const request=await f.json(beginSQL(f,question,answer));
    await f.json(dispatchSQL(request.id));
    const result=await f.json(finishSQL(request.id,"generated","What supports this choice?"));
    await f.exec(answerSQL({id:result.result_question_id},"Private child answer"));
    for(const [table,column,id] of [
      ["question_followup_requests","id",request.id],
      ["questions","id",result.result_question_id],
      ["answers","question_id",result.result_question_id],
    ]) {
      assert.equal(await f.json(`${auth("authenticated")} select count(*)::int as result
        from public.${table} where ${column}=${quote(id)};`),1);
      assert.equal(await f.json(`${auth("authenticated",other)} select count(*)::int as result
        from public.${table} where ${column}=${quote(id)};`),0);
    }
    await f.exec(`${auth("authenticated",other)} update public.answers set original_answer='Forbidden edit'
      where question_id=${quote(result.result_question_id)};`);
    assert.equal(await f.json(`${auth("authenticated")} select original_answer as result
      from public.answers where question_id=${quote(result.result_question_id)};`),"Private child answer");
    await assert.rejects(f.exec(`${auth("authenticated",other)} insert into public.answers(
      question_id,participant_id,original_answer) values(${quote(f.questions[1].id)},${quote(other)},'Foreign');`),
    /Answers can only be saved to an active, unskipped question owned by the participant/);
    await assert.rejects(f.exec(`${auth("authenticated")} select public.dispatch_question_followup(
      ${quote(request.id)},'UNTRUSTED');`),/permission denied/);
    await assert.rejects(f.exec(`${auth("anon")} select * from public.question_followup_requests;`),/permission denied/);
    await assert.rejects(f.exec(beginSQL(f,question,answer,randomUUID(),other)),
      /Active participant session required/);
  } finally {await f.close();}
});

test("an unanswered follow-up does not block completion of all original questions", async () => {
  const f = await pgliteFixture();
  try {
    const { question, answer } = await prepareAnsweredQuestion(f);
    const request = await f.json(beginSQL(f, question, answer));
    await f.json(dispatchSQL(request.id));
    await f.json(finishSQL(request.id, "generated", "What evidence most influenced that decision?"));
    for (const otherQuestion of f.questions.slice(1)) await f.exec(answerSQL(otherQuestion));
    await f.exec(completeSQL(f));
    const unansweredFollowup = await f.json(`select to_jsonb(count(*)) as result from public.questions q
      where q.session_id=${quote(f.session)} and q.question_kind='followup'
        and not exists (select 1 from public.answers a where a.question_id=q.id);`);
    assert.equal(unansweredFollowup, 1);
    const status = await f.json(`select status as result from public.sessions where id=${quote(f.session)};`);
    assert.equal(status, "completed");
  } finally { await f.close(); }
});

test("dispatched failures stay retryable without locking the answer; unknown outcomes never redispatch the same content",async()=>{
  const f=await pgliteFixture();
  try {
    const {question,answer}=await prepareAnsweredQuestion(f);
    const first=await f.json(beginSQL(f,question,answer));
    await f.json(dispatchSQL(first.id));
    assert.equal((await f.json(finishSQL(first.id,"failed"))).status,"failed");
    const second=await f.json(beginSQL(f,question,answer));
    assert.notEqual(second.id,first.id);
    await f.json(dispatchSQL(second.id));
    assert.equal((await f.json(finishSQL(second.id,"outcome_unknown"))).status,"outcome_unknown");
    const same=await f.json(beginSQL(f,question,answer));
    assert.equal(same.id,second.id);
    assert.equal(same.status,"outcome_unknown");
    assert.equal((await f.json(dispatchSQL(same.id))).acquired,false);
    await f.exec(`${auth("authenticated")} update public.answers set original_answer='Changed after an uncertain result'
      where question_id=${quote(question.id)};`);
  } finally {await f.close();}
});

test("pre-dispatch cleanup remains a failed request when the saved answer changed",async()=>{
  const f=await pgliteFixture();
  try {
    const {question,answer}=await prepareAnsweredQuestion(f);
    const request=await f.json(beginSQL(f,question,answer));
    await f.exec(`${auth("authenticated")} update public.answers set original_answer='Changed before dispatch'
      where question_id=${quote(question.id)};`);
    assert.equal((await f.json(finishSQL(request.id,"failed"))).status,"failed");
  } finally {await f.close();}
});

test("expired reservation recovery cannot fail a request that has already dispatched",async()=>{
  const f=await pgliteFixture();
  try {
    const {question,answer}=await prepareAnsweredQuestion(f);
    const request=await f.json(beginSQL(f,question,answer));
    await f.json(dispatchSQL(request.id));
    const recovered=await f.json(finishSQL(request.id,"failed",null,"FOLLOWUP-NOT-DISPATCHED"));
    assert.equal(recovered.status,"dispatch_started");
    assert.equal((await f.json(beginSQL(f,question,answer))).id,request.id);
    assert.equal((await f.json(finishSQL(request.id,"no_followup"))).status,"no_followup");
  } finally {await f.close();}
});

test("generated parents reject skip, reserve regeneration, refinement updates and further follow-ups",async()=>{
  const f=await pgliteFixture();
  try {
    const {question,answer}=await prepareAnsweredQuestion(f);
    const request=await f.json(beginSQL(f,question,answer));
    await f.json(dispatchSQL(request.id));
    const child=await f.json(finishSQL(request.id,"generated","Which comparison supports this decision?"));
    await assert.rejects(f.exec(`${auth()} select public.apply_question_action(
      ${quote(f.session)},${quote(question.id)},${quote(randomUUID())},'skip',
      ${quote(owner)},${quote(answer.updated_at)});`),/Written answers must be preserved|locked after follow-up generation|cannot be changed after follow-up generation/);
    await assert.rejects(f.exec(beginRegenerationSQL(f,question,randomUUID(),answer.updated_at)),
      /Written answers must be preserved|locked after follow-up generation|cannot be changed after follow-up generation/);
    await assert.rejects(f.exec(`${auth()} update public.questions set is_active_version=false
      where id=${quote(question.id)};`),/Question is locked after follow-up generation/);
    await assert.rejects(f.exec(`${auth("authenticated")} update public.answers
      set refined_answer='Refinement',refinement_used=true,current_answer_version='refined'
      where question_id=${quote(question.id)};`),/Answer is locked after follow-up generation/);
    await assert.rejects(f.exec(beginSQL(f,question,answer)),/Follow-up already generated/);
    await f.exec(answerSQL({id:child.result_question_id},"An optional child response."));
    const childAnswer=await f.json(`select jsonb_build_object('updated_at',updated_at,'text',original_answer)
      as result from public.answers where question_id=${quote(child.result_question_id)};`);
    await assert.rejects(f.exec(beginSQL(f,{id:child.result_question_id},childAnswer)),
      /Question is not eligible for follow-up/);
  } finally {await f.close();}
});

test("completion RPC and diary prompt remain valid with an unanswered optional follow-up",async()=>{
  const f=await pgliteFixture(3);
  try {
    await f.exec(read("supabase/migrations/20261010003000_session_completion_briefing.sql"));
    await f.exec(read("supabase/migrations/20261023000000_briefing_followup_snapshot.sql"));
    const {question,answer}=await prepareAnsweredQuestion(f);
    const request=await f.json(beginSQL(f,question,answer));
    await f.json(dispatchSQL(request.id));
    const child=await f.json(finishSQL(request.id,"generated","What alternative did you consider?"));
    for(const other of f.questions.slice(1))await f.exec(answerSQL(other));
    const completionId=randomUUID();
    const begun=await f.json(`${auth("authenticated")} select public.begin_session_completion(
      ${quote(f.session)},${quote(completionId)},null) as result;`);
    assert.equal(begun.state,"ready");
    assert.equal(begun.input_snapshot.answered_questions.length,3);
    assert.ok(begun.input_snapshot.answered_questions.every(q=>q.question_id!==child.result_question_id));
    assert.ok(begun.input_snapshot.answered_questions.every(q=>!("followup" in q)));
    assert.equal(await f.json(`${auth()} select public.authorize_session_briefing_dispatch(
      ${quote(f.session)},${quote(completionId)},${quote(owner)}) as result;`),true);
    await f.exec(`${auth()} select public.finish_session_briefing(
      ${quote(f.session)},${quote(completionId)},${quote(owner)},'A synthetic briefing.',
      'LOCAL-MOCK','session-design-briefing-v1.4','why_box_session_design_briefing_v1_0');`);
    const status=await f.json(`select status as result from public.sessions where id=${quote(f.session)};`);
    assert.equal(status,"completed");
    assert.equal(await f.json(`${auth("authenticated")} select public.claim_session_diary_prompt(
      ${quote(f.session)}) as result;`),true);
    assert.equal(await f.json(`${auth("authenticated")} select public.claim_session_diary_prompt(
      ${quote(f.session)}) as result;`),false);
  } finally {await f.close();}
});

test("snapshot migration requires the existing private function and never widens its ACL", async () => {
  const f = await pgliteFixture();
  try {
    const migration = read("supabase/migrations/20261023000000_briefing_followup_snapshot.sql");
    await f.db.exec("reset role;");
    await assert.rejects(f.db.exec(migration), /Existing briefing snapshot function required/);
    await f.db.exec("rollback;");
    await f.exec(read("supabase/migrations/20261010003000_session_completion_briefing.sql"));
    await f.exec("grant execute on function public.session_briefing_input_snapshot(uuid) to anon;");
    await assert.rejects(f.db.exec(migration), /Expected private postgres-owned briefing snapshot function/);
    await f.db.exec("rollback;");
    await f.exec("revoke execute on function public.session_briefing_input_snapshot(uuid) from anon;");
    await f.exec(migration);
    assert.equal(await f.json(`select to_jsonb(has_function_privilege(
      'anon','public.session_briefing_input_snapshot(uuid)','EXECUTE')) as result;`), false);
  } finally { await f.close(); }
});

test("new snapshot nests answered children by exact parent and session, freezes selected versions and preserves retry input", async () => {
  const f=await pgliteFixture(3);
  try {
    await f.exec(read("supabase/migrations/20261010003000_session_completion_briefing.sql"));
    const children=[];
    for(const question of f.questions){
      await prepareAnsweredQuestion(f,question,`Original answer ${question.slot_index}`);
      if(question.slot_index===1)await f.exec(`${auth("authenticated")} update public.answers
        set refined_answer='Selected parent refinement',refinement_used=true,
        current_answer_version='refined',refined_at=clock_timestamp()
        where question_id=${quote(question.id)};`);
      const answer=await f.json(`select jsonb_build_object('updated_at',updated_at,'text',
        case when current_answer_version='refined' then refined_answer else original_answer end)
        as result from public.answers where question_id=${quote(question.id)};`);
      const request=await f.json(beginSQL(f,question,answer));
      await f.json(dispatchSQL(request.id));
      const generated=await f.json(finishSQL(request.id,"generated",`Child of slot ${question.slot_index}?`));
      children.push(generated.result_question_id);
    }
    await f.exec(answerSQL({id:children[0]},"Original child reflection"));
    await f.exec(`${auth("authenticated")} update public.answers set refined_answer='An alternative remains uncertain',
      refinement_used=true,current_answer_version='refined',refined_at=clock_timestamp()
      where question_id=${quote(children[0])};`);
    await f.exec(answerSQL({id:children[1]},"Separate second child"));
    const before=await f.json(`select public.session_briefing_input_snapshot(${quote(f.session)}) as result;`);
    assert.ok(before.answered_questions.every(q=>!("followup" in q)));
    const acl=await f.json(`select jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig) as result
      from pg_proc where oid='public.session_briefing_input_snapshot(uuid)'::regprocedure;`);
    await f.exec(read("supabase/migrations/20261023000000_briefing_followup_snapshot.sql"));
    assert.deepEqual(await f.json(`select jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig) as result
      from pg_proc where oid='public.session_briefing_input_snapshot(uuid)'::regprocedure;`),acl);
    const snap=await f.json(`select public.session_briefing_input_snapshot(${quote(f.session)}) as result;`);
    assert.equal(snap.answered_questions.length,3);
    assert.equal(snap.answered_questions[0].answer.selected,"Selected parent refinement");
    assert.deepEqual(snap.answered_questions[0].followup,{
      session_id:f.session,question_id:children[0],parent_question_id:f.questions[0].id,
      question_text:"Child of slot 1?",
      answer:{original:"Original child reflection",refined:"An alternative remains uncertain",
        current_version:"refined",selected:"An alternative remains uncertain"},
    });
    assert.equal(snap.answered_questions[1].followup.parent_question_id,f.questions[1].id);
    assert.equal(snap.answered_questions[1].followup.answer.selected,"Separate second child");
    assert.equal(snap.answered_questions[2].followup,undefined);
    const foreign=await populate(f.exec,f.json,3);
    const foreignAnswer=await prepareAnsweredQuestion({...f,...foreign});
    const foreignRequest=await f.json(beginSQL(foreign,foreignAnswer.question,foreignAnswer.answer));
    await f.json(dispatchSQL(foreignRequest.id));
    const foreignChild=await f.json(finishSQL(foreignRequest.id,"generated","FOREIGN SESSION QUESTION"));
    await f.exec(answerSQL({id:foreignChild.result_question_id},"FOREIGN SESSION ANSWER"));
    assert.deepEqual(await f.json(`select public.session_briefing_input_snapshot(${quote(f.session)}) as result;`),snap);
    await assert.rejects(f.json(`${auth("authenticated",other)} select public.begin_session_completion(
      ${quote(f.session)},${quote(randomUUID())},null) as result;`),/Session ownership required/);
    await f.exec(`${auth("authenticated")} update public.answers set original_answer=E' \\t\\n\\r '
      where question_id=${quote(children[1])};`);
    const blank=await f.json(`select public.session_briefing_input_snapshot(${quote(f.session)}) as result;`);
    assert.equal(blank.answered_questions[1].followup,undefined);
    const completionId=randomUUID();
    const begun=await f.json(`${auth("authenticated")} select public.begin_session_completion(
      ${quote(f.session)},${quote(completionId)},null) as result;`);
    assert.deepEqual(begun.input_snapshot,blank);
    await f.exec(`${auth()} select public.authorize_session_briefing_dispatch(
      ${quote(f.session)},${quote(completionId)},${quote(owner)});
      select public.fail_session_briefing(${quote(f.session)},${quote(completionId)},${quote(owner)},'LOCAL-FAIL',false);`);
    const retried=await f.json(`${auth("authenticated")} select public.begin_session_completion(
      ${quote(f.session)},${quote(randomUUID())},${quote(completionId)}) as result;`);
    assert.deepEqual(retried.input_snapshot,begun.input_snapshot);
    await assert.rejects(f.exec(`${auth()} update public.answers set original_answer='Too late'
      where question_id=${quote(children[0])};`),/Answers are editable only while reflection is in progress/);
  } finally {await f.close();}
});

test("migration leaves existing completed briefing and legacy failed-request snapshot unchanged",async()=>{
  const f=await pgliteFixture(3);
  try {
    await f.exec(read("supabase/migrations/20261010003000_session_completion_briefing.sql"));
    for(const q of f.questions)await f.exec(answerSQL(q));
    const completionId=randomUUID();
    const begun=await f.json(`${auth("authenticated")} select public.begin_session_completion(
      ${quote(f.session)},${quote(completionId)},null) as result;`);
    const before=await f.json(`select jsonb_agg(to_jsonb(r)) as result from public.session_briefing_requests r;`);
    await f.exec(read("supabase/migrations/20261023000000_briefing_followup_snapshot.sql"));
    assert.deepEqual(await f.json(`select jsonb_agg(to_jsonb(r)) as result from public.session_briefing_requests r;`),before);
    await f.exec(`${auth()} select public.authorize_session_briefing_dispatch(
      ${quote(f.session)},${quote(completionId)},${quote(owner)});
      select public.fail_session_briefing(${quote(f.session)},${quote(completionId)},${quote(owner)},'LOCAL-FAIL',false);`);
    const retryId=randomUUID();
    const retry=await f.json(`${auth("authenticated")} select public.begin_session_completion(
      ${quote(f.session)},${quote(retryId)},${quote(completionId)}) as result;`);
    assert.deepEqual(retry.input_snapshot,begun.input_snapshot);
    await f.exec(`${auth()} select public.authorize_session_briefing_dispatch(
      ${quote(f.session)},${quote(retryId)},${quote(owner)});
      select public.finish_session_briefing(${quote(f.session)},${quote(retryId)},${quote(owner)},
      'Existing source','MOCK','session-design-briefing-v1.4','why_box_session_design_briefing_v1_0');`);
    const stored=await f.json(`select jsonb_build_object('session',to_jsonb(s),
      'sources',(select jsonb_agg(to_jsonb(b)) from public.session_briefing_sources b)) as result
      from public.sessions s where s.id=${quote(f.session)};`);
    await f.exec(read("supabase/migrations/20261023000000_briefing_followup_snapshot.sql"));
    assert.deepEqual(await f.json(`select jsonb_build_object('session',to_jsonb(s),
      'sources',(select jsonb_agg(to_jsonb(b)) from public.session_briefing_sources b)) as result
      from public.sessions s where s.id=${quote(f.session)};`),stored);
  } finally {await f.close();}
});
