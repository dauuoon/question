import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { URL } from "node:url";
import { typescriptLoader } from "./helpers/typescript-loader.mjs";
import {
  pgliteFixture, owner, other, auth, quote, answerSQL,
} from "./question-regeneration-fixture.mjs";

const migration = "20261010003000_session_completion_briefing.sql";
const answer = (f, question, text = "My design balances clarity and flexibility.") =>
  f.exec(answerSQL(question, text));
const skip = (f, question, requestId) => f.json(`${auth()}
  select public.apply_question_action(${quote(f.session)},${quote(question.id)},${quote(requestId)},
    'skip',${quote(owner)},null) as result;`);
const begin = (f, requestId, retryOf = null, actor = owner) => f.json(`${auth("authenticated", actor)}
  select public.begin_session_completion(${quote(f.session)},${quote(requestId)},${quote(retryOf)}) as result;`);
const dispatch = (f, requestId) => f.json(`${auth()}
  select public.authorize_session_briefing_dispatch(${quote(f.session)},${quote(requestId)},${quote(owner)}) as result;`);
const fail = (f, requestId, code, unknown = false) => f.json(`${auth()}
  select public.fail_session_briefing(${quote(f.session)},${quote(requestId)},${quote(owner)},
    ${quote(code)},${unknown}) as result;`);
const finish = (f, requestId, text = "The design connects the user's goals with the chosen visual structure.") =>
  f.json(`${auth()} select public.finish_session_briefing(${quote(f.session)},${quote(requestId)},${quote(owner)},
    ${quote(text)},'TEST-MOCK-MODEL','session-design-briefing-v1.0',
    'why_box_session_design_briefing_v1_0') as result;`);

async function apply(f) {
  await f.db.exec(readFileSync(new URL(`../supabase/migrations/${migration}`, import.meta.url), "utf8"));
  await f.db.exec(readFileSync(new URL("../supabase/migrations/20261023000000_briefing_followup_snapshot.sql", import.meta.url), "utf8"));
  await f.db.exec(readFileSync(new URL("../supabase/migrations/20261113060000_briefing_choice_snapshot.sql", import.meta.url), "utf8"));
}

for(const explanation of ["","투명도에 따라 색이 어떻게 달라지는지 확인합니다."]) {
  test(`choice answer ${explanation?"with text":"alone"} reaches saved mock briefing without other options`,async t=>{
    const form={kind:"choice",title:"비교할 부분",labels:["겹친 부분의 색","도형의 경계","직접 입력","짧은 설명"],
      max_selections:2,explanation_prompt:"어떤 차이를 확인하나요?"};
    const f=await pgliteFixture(3,[form],"question-generation-v2.13");t.after(()=>f.close());
    await apply(f);
    const permissions=(await f.db.query(`select
      has_function_privilege('authenticated','public.briefing_choice_selection(jsonb,text[],text)','EXECUTE') as helper,
      has_function_privilege('authenticated','public.session_briefing_input_snapshot(uuid)','EXECUTE') as snapshot,
      has_function_privilege('authenticated','public.briefing_choice_snapshot_ready()','EXECUTE') as ready`)).rows[0];
    assert.deepEqual(permissions,{helper:false,snapshot:false,ready:true});
    const text=["겹친 부분의 색",explanation].filter(Boolean).join("\n\n");
    await f.exec(`${auth("authenticated")} insert into public.answers(question_id,participant_id,original_answer,original_answer_fields)
      values(${quote(f.questions[0].id)},${quote(owner)},${quote(text)},
        array['겹친 부분의 색','','',${quote(explanation)}]);`);
    await skip(f,f.questions[1],"70000000-0000-4000-8000-000000000301");
    await skip(f,f.questions[2],"70000000-0000-4000-8000-000000000302");
    const requestId="40000000-0000-4000-8000-000000000301";
    const begun=await begin(f,requestId);
    assert.equal(begun.accepted,true);
    const snap=begun.input_snapshot;
    assert.deepEqual(snap.answered_questions[0].answer.choice_selection,
      {selected_options:["겹친 부분의 색"],other:"",explanation});
    const load=typescriptLoader();
    const provider=load("src/lib/ai/server/session-briefing-provider.ts");
    const payload=JSON.parse(provider.sessionBriefingParameters("test-model",snap).input[0].content[0].text);
    assert.deepEqual(payload.final_answers[0].choice_context,
      {question:"Initial question 1?",selected_options:["겹친 부분의 색"],other:"",explanation});
    assert.doesNotMatch(JSON.stringify(payload),/도형의 경계|직접 입력|짧은 설명|비교할 부분/);
    const mock=provider.createMockSessionBriefingProvider({NODE_ENV:"development",SESSION_BRIEFING_MOCK_ENABLED:"true",
      NEXT_PUBLIC_SUPABASE_URL:"https://njtgxnlxlhxpbiekbgmv.supabase.co"});
    const output=await mock.generate(snap);
    assert.match(output.response.briefing_text,/겹친 부분의 색/);
    if(explanation)assert.ok(output.response.briefing_text.includes(explanation));
    assert.doesNotMatch(output.response.briefing_text,/도형의 경계|직접 입력|짧은 설명|비교할 부분/);
    assert.equal(await dispatch(f,requestId),true);
    assert.equal((await finish(f,requestId,output.response.briefing_text)).state,"completed");
    assert.equal(await f.json(`select to_jsonb(summary_text) as result from public.sessions where id=${quote(f.session)}`),
      output.response.briefing_text);
  });
}

test("choice answer on a follow-up is frozen separately in the briefing snapshot",async t=>{
  const f=await pgliteFixture(3);t.after(()=>f.close());
  await apply(f);
  const parent=f.questions[0],text="기존에 작성한 생각";
  await answer(f,parent,text);
  const revision=(await f.db.query("select updated_at::text revision from answers where question_id=$1",[parent.id])).rows[0].revision;
  const request=await f.json(`${auth()} select public.begin_question_followup(${quote(f.session)},${quote(parent.id)},
    ${quote(randomUUID())},${quote(owner)},${quote(revision)},${quote(createHash("sha256").update(text).digest("hex"))},
    ${quote(text)},'question-followup-v1.8') as result;`);
  const form={kind:"choice",title:"비교",labels:["색","경계","직접 입력","짧은 설명"],
    max_selections:2,explanation_prompt:"어떤 차이를 확인하나요?"};
  await f.exec(`${auth()} select public.dispatch_question_followup(${quote(request.id)},'LOCAL-MOCK');`);
  const finished=await f.json(`${auth()} select public.finish_question_followup(${quote(request.id)},'generated',
    '무엇을 확인하나요?','LOCAL-MOCK',10,20,null,${quote(JSON.stringify(form))}::jsonb) as result;`);
  await f.exec(`${auth("authenticated")} insert into answers(question_id,participant_id,original_answer,original_answer_fields)
    values(${quote(finished.result_question_id)},${quote(owner)},'색',array['색','','','']);`);
  await skip(f,f.questions[1],"70000000-0000-4000-8000-000000000311");
  await skip(f,f.questions[2],"70000000-0000-4000-8000-000000000312");
  const begun=await begin(f,"40000000-0000-4000-8000-000000000311");
  assert.deepEqual(begun.input_snapshot.answered_questions[0].followup.answer.choice_selection,
    {selected_options:["색"],other:"",explanation:""});
  const provider=typescriptLoader()("src/lib/ai/server/session-briefing-provider.ts");
  const payload=JSON.parse(provider.sessionBriefingParameters("test-model",begun.input_snapshot).input[0].content[0].text);
  assert.deepEqual(payload.final_answers[0].followup.choice_context,{selected_options:["색"],other:"",explanation:""});
  assert.doesNotMatch(JSON.stringify(payload),/경계|직접 입력|짧은 설명/);
});

test("completion validates active slots and selected answers before freezing the session", async () => {
  const f = await pgliteFixture(3);
  try {
    await apply(f);
    const blocked = await begin(f, "40000000-0000-4000-8000-000000000101");
    assert.equal(blocked.accepted, false);
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.missing_question_ids.length, 3);
    assert.equal(blocked.has_answer, false);
    assert.equal(await f.json(`select to_jsonb(status) as result from public.sessions where id=${quote(f.session)}`), "in_progress");

    await answer(f, f.questions[0], "I want the interface to feel calm without hiding important choices.");
    await f.exec(`${auth("authenticated")} update public.answers set refined_answer=
      'I want the interface to feel calm and keep important choices visible.',
      refinement_used=true,refined_at=clock_timestamp(),current_answer_version='refined'
      where question_id=${quote(f.questions[0].id)};`);
    await skip(f, f.questions[1], "70000000-0000-4000-8000-000000000101");
    const stillBlocked = await begin(f, "40000000-0000-4000-8000-000000000102");
    assert.deepEqual(stillBlocked.missing_question_ids, [f.questions[2].id]);
    assert.equal(stillBlocked.has_answer, true);
    await skip(f, f.questions[2], "70000000-0000-4000-8000-000000000102");

    const requestId = "40000000-0000-4000-8000-000000000103";
    const accepted = await begin(f, requestId);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.state, "ready");
    assert.equal(accepted.attempt_number, 1);
    assert.equal(accepted.input_snapshot.answered_questions.length, 1);
    assert.equal(accepted.input_snapshot.answered_questions[0].answer.selected,
      "I want the interface to feel calm and keep important choices visible.");
    assert.equal(accepted.input_snapshot.answered_questions[0].answer.original,
      "I want the interface to feel calm without hiding important choices.");
    assert.equal(accepted.input_snapshot.answered_questions[0].answer.current_version, "refined");
    assert.equal(accepted.input_snapshot.session_id, f.session);
    assert.equal(await f.json(`select to_jsonb(status) as result from public.sessions where id=${quote(f.session)}`), "summary_ready");
    const replay = await begin(f, requestId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.state, "ready");
    assert.equal(await f.json(`select to_jsonb(count(*)::int) as result from public.session_briefing_requests where session_id=${quote(f.session)}`), 1);
    const duplicateRequest = await begin(f, "40000000-0000-4000-8000-000000000104");
    assert.equal(duplicateRequest.accepted, false);
    assert.equal(duplicateRequest.state, "blocked");
    assert.equal(await f.json(`select to_jsonb(count(*)::int) as result from public.session_briefing_requests where session_id=${quote(f.session)}`), 1);
  } finally {
    await f.close();
  }
});

test("all skipped questions cannot complete a session without an actual answer", async () => {
  const f = await pgliteFixture(2);
  try {
    await apply(f);
    await skip(f, f.questions[0], "70000000-0000-4000-8000-000000000151");
    await skip(f, f.questions[1], "70000000-0000-4000-8000-000000000152");
    const result = await begin(f, "40000000-0000-4000-8000-000000000151");
    assert.equal(result.accepted, false);
    assert.equal(result.has_answer, false);
    assert.deepEqual(result.missing_question_ids, []);
    assert.equal(await f.json(`select to_jsonb(status) as result from public.sessions where id=${quote(f.session)}`), "in_progress");
  } finally {
    await f.close();
  }
});

test("completion and briefing request reads reject cross-participant access", async () => {
  const f = await pgliteFixture(1);
  try {
    await apply(f);
    await answer(f, f.questions[0]);
    const requestId = "40000000-0000-4000-8000-000000000181";
    const rejectedBegin = `${auth("authenticated", other)}
      select public.begin_session_completion(${quote(f.session)},${quote(requestId)},null);`;
    await assert.rejects(f.exec(rejectedBegin), /Session ownership required/);
    const accepted = await begin(f, requestId);
    assert.equal(accepted.accepted, true);
    await assert.rejects(f.exec(`${auth("authenticated", other)}
      select public.read_session_briefing_request(${quote(f.session)},${quote(requestId)});`),
    /Session access required/);
    assert.equal(await f.json(`${auth("authenticated")}
      select to_jsonb(count(*)::int) as result from public.session_briefing_requests
      where session_id=${quote(f.session)}`), 1);
  } finally {
    await f.close();
  }
});

test("dispatch is one-shot; completed briefing source and session completion commit atomically", async () => {
  const f = await pgliteFixture(2);
  try {
    await apply(f);
    await answer(f, f.questions[0]);
    await skip(f, f.questions[1], "70000000-0000-4000-8000-000000000201");
    const requestId = "40000000-0000-4000-8000-000000000201";
    await begin(f, requestId);
    assert.equal(await dispatch(f, requestId), true);
    assert.equal(await dispatch(f, requestId), false);
    const finished = await finish(f, requestId);
    assert.equal(finished.state, "completed");
    assert.equal(finished.replayed, false);
    assert.equal(await finish(f, requestId).then((value) => value.replayed), true);
    assert.equal(await f.json(`select to_jsonb(status) as result from public.sessions where id=${quote(f.session)}`), "completed");
    assert.equal(await f.json(`select to_jsonb(summary_text) as result from public.sessions where id=${quote(f.session)}`),
      "The design connects the user's goals with the chosen visual structure.");
    assert.equal(await f.json(`select to_jsonb(count(*)::int) as result from public.session_briefing_sources where session_id=${quote(f.session)}`), 1);
    assert.equal(await f.json(`select to_jsonb(state) as result from public.session_briefing_requests where session_id=${quote(f.session)}`), "completed");
    const replay = await begin(f, requestId);
    assert.equal(replay.state, "completed");
    assert.equal(replay.replayed, true);
    await assert.rejects(f.exec(`update public.session_briefing_sources set source_text='mutated'`), /immutable/);
    await assert.rejects(f.exec(`delete from public.session_briefing_sources`), /cannot be deleted/);
    await assert.rejects(f.exec(`update public.sessions set summary_text='changed' where id=${quote(f.session)}`),
      /Completed sessions are immutable/);
  } finally {
    await f.close();
  }
});

test("only one explicit retry follows a definitive failure; unknown dispatch cannot retry", async () => {
  const f = await pgliteFixture(1);
  try {
    await apply(f);
    await answer(f, f.questions[0]);
    const firstId = "40000000-0000-4000-8000-000000000301";
    await begin(f, firstId);
    assert.equal(await fail(f, firstId, "BRIEFING-VALIDATION"), true);
    assert.equal(await f.json(`select to_jsonb(status) as result from public.sessions where id=${quote(f.session)}`), "summary_ready");
    assert.equal(await f.json(`select to_jsonb(status) as result from public.questions
      where id=${quote(f.questions[0].id)}`), "answered");
    assert.equal(await f.json(`select to_jsonb(count(*)::int) as result from public.session_briefing_sources
      where session_id=${quote(f.session)}`), 0);
    const retryId = "40000000-0000-4000-8000-000000000302";
    const retry = await begin(f, retryId, firstId);
    assert.equal(retry.accepted, true);
    assert.equal(retry.attempt_number, 2);
    assert.deepEqual(retry.input_snapshot, (await begin(f, firstId)).input_snapshot);
    await assert.rejects(begin(f, "40000000-0000-4000-8000-000000000303", firstId),
      /Only one explicit retry|55000/);

    const g = await pgliteFixture(1);
    try {
      await apply(g);
      await answer(g, g.questions[0]);
      const unknownId = "40000000-0000-4000-8000-000000000311";
      await begin(g, unknownId);
      await dispatch(g, unknownId);
      assert.equal(await fail(g, unknownId, "BRIEFING-TIMEOUT", true), true);
      assert.equal((await begin(g, unknownId)).state, "dispatch_unknown");
      await assert.rejects(begin(g, "40000000-0000-4000-8000-000000000312", unknownId),
        /Only one explicit retry|55000/);
    } finally {
      await g.close();
    }
  } finally {
    await f.close();
  }
});

test("briefing edits use CAS revisions; owner and active admin can read while another participant cannot", async () => {
  const f = await pgliteFixture(1);
  const admin = "10000000-0000-4000-8000-000000000003";
  try {
    await apply(f);
    await f.exec(`insert into auth.users values(${quote(admin)});
      insert into public.profiles(id,role,status) values(${quote(admin)},'admin','active');`);
    await answer(f, f.questions[0]);
    const requestId = "40000000-0000-4000-8000-000000000401";
    await begin(f, requestId);
    await dispatch(f, requestId);
    await finish(f, requestId);

    const save = (revision, text, actor = owner) => f.json(`${auth("authenticated", actor)}
      select public.save_session_briefing_version(${quote(f.session)},${revision},${quote(text)}) as result;`);
    await assert.rejects(f.exec(`${auth("authenticated")} select public.save_session_briefing_version(
      ${quote(f.session)},null,'Invalid CAS revision')`), /nonnegative briefing revision/);
    assert.deepEqual(await save(0, "Participant's first revision."), { saved: true, revision: 1 });
    assert.deepEqual(await save(0, "A stale edit."), { saved: false, current_revision: 1 });
    assert.deepEqual(await save(1, "Participant's second revision."), { saved: true, revision: 2 });
    assert.deepEqual(await f.json(`${auth("authenticated")} select public.read_session_briefing_request(
      ${quote(f.session)},${quote(requestId)}) as result;`).then((value) => value.state), "completed");
    assert.equal(await f.json(`${auth("authenticated", other)}
      select to_jsonb(count(*)::int) as result from public.session_briefing_sources where session_id=${quote(f.session)}`), 0);
    assert.equal(await f.json(`${auth("authenticated", admin)}
      select to_jsonb(count(*)::int) as result from public.session_briefing_sources where session_id=${quote(f.session)}`), 1);
    assert.equal(await f.json(`${auth("authenticated", other)}
      select to_jsonb(count(*)::int) as result from public.session_briefing_versions where session_id=${quote(f.session)}`), 0);
    assert.equal(await f.json(`${auth("authenticated", admin)}
      select to_jsonb(count(*)::int) as result from public.session_briefing_versions where session_id=${quote(f.session)}`), 2);
    const versions = await f.json(`select jsonb_agg(jsonb_build_object('revision',revision,'text',briefing_text)
      order by revision) as result from public.session_briefing_versions where session_id=${quote(f.session)}`);
    assert.deepEqual(versions, [
      { revision: 1, text: "Participant's first revision." },
      { revision: 2, text: "Participant's second revision." },
    ]);
    await assert.rejects(f.exec(`${auth("authenticated")} insert into public.session_briefing_versions(
      session_id,revision,briefing_text,edited_by) values(${quote(f.session)},3,'Direct write',${quote(owner)})`),
    /permission denied/);
  } finally {
    await f.close();
  }
});

test("diary prompt claim is once per completed session and is blocked for a submitted diary", async () => {
  const f = await pgliteFixture(1);
  try {
    await apply(f);
    await answer(f, f.questions[0]);
    const requestId = "40000000-0000-4000-8000-000000000501";
    await begin(f, requestId);
    await dispatch(f, requestId);
    await finish(f, requestId);
    const claim = () => f.json(`${auth("authenticated")}
      select public.claim_session_diary_prompt(${quote(f.session)}) as result;`);
    assert.equal(await claim(), true);
    assert.equal(await claim(), false);
    assert.equal(await f.json(`select to_jsonb(count(*)::int) as result from public.session_diary_prompt_shown where session_id=${quote(f.session)}`), 1);

    const g = await pgliteFixture(1);
    try {
      await apply(g);
      await answer(g, g.questions[0]);
      const submittedRequest = "40000000-0000-4000-8000-000000000502";
      await begin(g, submittedRequest);
      await dispatch(g, submittedRequest);
      await finish(g, submittedRequest);
      await g.exec(`${auth("authenticated")} insert into public.diaries(
        session_id,participant_id,experience_choices_json,feeling_choices_json,status,submitted_at
      ) values(${quote(g.session)},${quote(owner)},'["clear"]'::jsonb,'["confident"]'::jsonb,
        'submitted',clock_timestamp());`);
      assert.equal(await g.json(`${auth("authenticated")}
        select public.claim_session_diary_prompt(${quote(g.session)}) as result;`), false);
      assert.equal(await g.json(`select to_jsonb(count(*)::int) as result from public.session_diary_prompt_shown where session_id=${quote(g.session)}`), 0);
    } finally {
      await g.close();
    }
  } finally {
    await f.close();
  }
});
