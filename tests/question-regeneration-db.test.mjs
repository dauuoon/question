import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  pgliteFixture, owner, other, auth, quote, candidate, beginSQL, dispatchSQL, stageSQL,
  commitSQL, failSQL, recoverSQL, answerSQL, pinsSQL, targetsSQL, expireSQL,
} from "./question-regeneration-fixture.mjs";

const rejected = (f, sql, pattern) => assert.rejects(f.exec(sql), pattern);
const calls = (f) => f.json(`select to_jsonb(count(*)) as result from public.question_regeneration_attempts
  where session_id=${quote(f.session)} and dispatched_at is not null;`);
const privateRead = (r) => `${auth()} select public.get_question_regeneration_attempt(
  ${quote(r.attempt_id)},${quote(r.request_id)},${quote(owner)}) as result;`;
const capabilities = (f) => `${auth("authenticated")} select public.read_question_action_capabilities(${quote(f.session)}) as result;`;
async function assertPending(f, r, remaining) {
  const cap = (await f.json(capabilities(f))).regeneration;
  assert.equal(cap.pending_request_id, r.request_id);
  assert.equal(cap.pending_question_id, r.question_id);
  assert.equal(cap.calls_remaining, remaining);
}

test("API admission, dispatch CAS, single candidate atomic commit, replay and private grants", async () => {
  const f = await pgliteFixture();
  try {
    const r = await f.json(beginSQL(f));
    assert.equal(r.status, "reserved");
    assert.equal(r.acquired, true);
    await assertPending(f, r, 3);
    assert.equal(await calls(f), 0);
    assert.equal((await f.json(beginSQL(f, f.questions[0], r.request_id))).acquired, false);
    await rejected(f, beginSQL(f, f.questions[1], r.request_id), /identity changed/);
    await rejected(f, beginSQL(f), /pending/);
    await rejected(f, beginSQL(f, f.questions[0], r.request_id, null, false), /identity changed/);
    const snapshot = await f.json(privateRead(r));
    await rejected(f, privateRead(r).replace(`,${quote(owner)})`, ",null)"), /identity required/);
    await rejected(f, privateRead(r).replace(quote(r.request_id), "null"), /identity required/);
    assert.equal(snapshot.image_snapshot.length, 2);
    assert.equal(snapshot.exclusion_snapshot.length, 5);
    assert.equal(snapshot.root_question_id, f.questions[0].id);
    assert.equal(snapshot.id, r.attempt_id);
    assert.equal(snapshot.slot_index, f.questions[0].slot_index);
    assert.equal(snapshot.regeneration_index, 0);
    assert.equal(await f.json(dispatchSQL(r)), true);
    await assertPending(f, r, 2);
    assert.equal(await f.json(dispatchSQL(r)), false);
    assert.equal(await calls(f), 1);
    await rejected(f, answerSQL(f.questions[0]), /pending/);
    await f.exec(answerSQL(f.questions[1]));
    await rejected(f, `${auth()} select public.apply_question_action(${quote(f.session)},${quote(f.questions[0].id)},
      ${quote(randomUUID())},'skip',${quote(owner)},null);`, /pending/);
    // Answering another slot changes exclusions; fail rather than overwrite old pins.
    await rejected(f, stageSQL(r), /snapshot changed/);
    await f.json(failSQL(r, "QR-STALE"));
    assert.equal((await f.json(capabilities(f))).regeneration.pending_question_id, null);
    assert.equal(await f.json(dispatchSQL(r)), false);
    const r2 = await f.json(beginSQL(f));
    assert.equal(await f.json(dispatchSQL(r2)), true);
    const c = await f.json(stageSQL(r2));
    assert.equal(c.staged, true);
    await assertPending(f, r2, 1);
    assert.equal((await f.json(stageSQL(r2))).staged, false);
    await rejected(f, stageSQL(r2, candidate("Conflicting output?")), /identity changed/);
    const result = await f.json(commitSQL(r2));
    assert.equal(result.status, "completed");
    assert.equal(result.changed, true);
    assert.equal(result.method, "api_generated");
    assert.equal((await f.json(capabilities(f))).regeneration.pending_request_id, null);
    assert.equal((await f.json(capabilities(f))).regeneration.pending_question_id, null);
    assert.equal((await f.json(commitSQL(r2))).changed, false);
    assert.equal((await f.json(beginSQL(f, f.questions[0], r2.request_id))).result_question_id, result.result_question_id);
    assert.equal(await f.json(dispatchSQL(r2)), false);
    const now = await f.json(pinsSQL(f));
    const old = now.find((q) => q.id === f.questions[0].id);
    const next = now.find((q) => q.id === result.result_question_id);
    assert.equal(old.is_active_version, false);
    assert.equal(next.root_question_id, old.id);
    assert.equal(next.parent_question_id, old.id);
    assert.equal(next.regeneration_index, 1);
    assert.equal(next.source_candidate_id, null);
    assert.equal(next.source_regeneration_candidate_id, c.candidate_id);
    const targets = await f.json(targetsSQL(f));
    assert.equal(targets.find((t) => t.question_id === next.id).image_id, f.images[1]);
    assert.equal(targets.filter((t) => t.question_id === old.id).length, 1);
    const safe = await f.json(`${auth("authenticated")} select public.read_question_regeneration(
      ${quote(f.session)},${quote(r2.request_id)}) as result;`);
    assert.equal(safe.status, "completed");
    assert.equal(safe.input_snapshot, undefined);
    await rejected(f, `${auth("authenticated", other)} select public.read_question_regeneration(${quote(f.session)},${quote(r2.request_id)});`, /ownership/);
    for (const role of ["anon", "authenticated"]) {
      await rejected(f, dispatchSQL(r2).replace(auth(), auth(role)), /permission denied/);
      await rejected(f, privateRead(r2).replace(auth(), auth(role)), /permission denied/);
      for (const table of ["requests", "attempts", "candidates", "events"])
        await rejected(f, `${auth(role)} select * from public.question_regeneration_${table};`, /permission denied/);
    }
    await rejected(f, `${auth()} update public.question_regeneration_requests set status='reserved';`, /permission denied/);
    assert.equal(await f.json(`select to_jsonb(count(*)) as result from public.question_generation_attempts;`), 1);
    assert.equal(await f.json(`select to_jsonb(count(*)) as result from public.question_candidates;`), 5);
  } finally { await f.close(); }
});

test("reserve first including skipped/empty answer history; flag off and two-success slot limit", async () => {
  const f = await pgliteFixture(3);
  try {
    const q = f.questions[0];
    await f.exec(answerSQL(q, "  "));
    const rev = await f.json(`select to_jsonb(updated_at) as result from public.answers where question_id=${quote(q.id)};`);
    await f.exec(`${auth()} select public.apply_question_action(${quote(f.session)},${quote(q.id)},${quote(randomUUID())},'skip',${quote(owner)},${quote(rev)});`);
    const reserve = await f.json(beginSQL(f, q, randomUUID(), rev, false));
    assert.equal(reserve.method, "reserve");
    assert.equal(reserve.attempt_id, null);
    const now = await f.json(pinsSQL(f));
    assert.equal(now.find((row) => row.id === q.id).status, "skipped");
    assert.equal(await f.json(`select to_jsonb(question_id) as result from public.answers where question_id=${quote(q.id)};`), q.id);
    const current = now.find((row) => row.id === reserve.result_question_id);
    const second = await f.json(beginSQL(f, current));
    assert.equal(second.method, "reserve");
    assert.equal(await calls(f), 0);
    const next = (await f.json(pinsSQL(f))).find((row) => row.id === second.result_question_id);
    await rejected(f, beginSQL(f, next), /limit reached/);
    await rejected(f, beginSQL(f, f.questions[1], randomUUID(), null, false), /No unused reserve/);
    const cap = await f.json(`${auth("authenticated")} select public.read_question_action_capabilities(${quote(f.session)}) as result;`);
    assert.equal(cap.reserve_count, 0);
    assert.equal(cap.regeneration.calls_remaining, 3);
    assert.equal(cap.reserve_count_by_question[next.id], 0);
    assert.equal(cap.regeneration.per_question.find((row) => row.question_id===next.id).reserve_count, 0);
    // A skipped original with no written answer is also allowed on the API path.
    await f.exec(`${auth()} select public.apply_question_action(${quote(f.session)},${quote(f.questions[1].id)},
      ${quote(randomUUID())},'skip',${quote(owner)},null);`);
    const api = await f.json(beginSQL(f, f.questions[1]));
    await f.json(dispatchSQL(api)); await f.json(stageSQL(api)); await f.json(commitSQL(api));
    assert.equal((await f.json(pinsSQL(f))).find((row) => row.id === f.questions[1].id).status, "skipped");
  } finally { await f.close(); }
});

test("failed/timeout/unknown consume dispatch budget; pre-dispatch expiry does not and unknown cannot redispatch", async () => {
  const f = await pgliteFixture();
  try {
    const before = await f.json(pinsSQL(f));
    const pins = await f.json(targetsSQL(f));
    const reserved = await f.json(beginSQL(f));
    await f.exec(expireSQL(reserved));
    await rejected(f, dispatchSQL(reserved), /expired/);
    assert.equal((await f.json(recoverSQL(reserved))).status, "failed");
    assert.equal(await calls(f), 0);
    for (const [code, unknown] of [["QR-VALIDATION", false], ["QR-TIMEOUT", false], ["QR-OUTCOME-UNKNOWN", true]]) {
      const r = await f.json(beginSQL(f));
      await f.json(dispatchSQL(r));
      if (unknown) {
        await f.exec(expireSQL(r, true));
        assert.equal((await f.json(recoverSQL(r))).status, "dispatch_unknown");
      } else {
        await rejected(f, failSQL(r, "raw provider secret"), /safe failure/);
        assert.equal(await f.json(failSQL(r, code)), true);
        assert.equal((await f.json(privateRead(r))).status, code==="QR-TIMEOUT" ? "dispatch_unknown" : "failed");
      }
      assert.equal(await f.json(dispatchSQL(r)), false);
      await rejected(f, stageSQL(r), /Dispatch required/);
      assert.equal((await f.json(beginSQL(f, f.questions[0], r.request_id))).acquired, false);
      assert.equal(await f.json(failSQL(r, code, unknown)), false);
    }
    assert.equal(await calls(f), 3);
    await rejected(f, beginSQL(f), /dispatch limit/);
    assert.deepEqual(await f.json(pinsSQL(f)), before);
    assert.deepEqual(await f.json(targetsSQL(f)), pins);
  } finally { await f.close(); }
});

test("lost dispatch authorization response derives unknown from DB and legacy IDs cannot bypass admission", async () => {
  const f = await pgliteFixture(3);
  try {
    // Exhaust reserves without using the target slot.
    let q = f.questions[1];
    for (let i=0;i<2;i++) {
      const result=await f.json(beginSQL(f,q));
      q=(await f.json(pinsSQL(f))).find((row)=>row.id===result.result_question_id);
    }
    const r=await f.json(beginSQL(f));
    await f.json(dispatchSQL(r));
    assert.equal(await f.json(failSQL(r,"QR-RECOVERY",false)),true);
    assert.equal((await f.json(privateRead(r))).status,"dispatch_unknown");
    assert.equal(await calls(f),1);
    assert.equal(await f.json(dispatchSQL(r)),false);
    const before=await f.json(pinsSQL(f));
    await rejected(f,`${auth()}select public.apply_question_action(${quote(f.session)},${quote(f.questions[2].id)},
      ${quote(r.request_id)},'skip',${quote(owner)},null);`,/identity changed/);
    await rejected(f,`insert into public.question_action_requests(session_id,participant_id,request_id,question_id,
      action,result_question_id) values(${quote(f.session)},${quote(owner)},${quote(r.request_id)},
      ${quote(r.question_id)},'regenerate',${quote(r.question_id)});`,/already admitted/);
    assert.deepEqual(await f.json(pinsSQL(f)),before);
    const predispatch=await f.json(beginSQL(f));
    await f.json(failSQL(predispatch,"QR-RECOVERY",false));
    assert.equal((await f.json(privateRead(predispatch))).status,"failed");
    assert.equal(await calls(f),1);
  } finally { await f.close(); }
});

test("validation, stage atomicity, snapshot stale, immutable histories and provenance", async () => {
  const f = await pgliteFixture();
  try {
    const r = await f.json(beginSQL(f));
    await rejected(f, stageSQL(r), /Dispatch required/);
    await f.json(dispatchSQL(r));
    const invalids = [
      { ...candidate(), candidate_rank: 2 },
      { ...candidate(), candidate_rank: null },
      { ...candidate(), answer_guides: null },
      { ...candidate(), related_contexts: null },
      { ...candidate(), target: null },
      { ...candidate(), question_text: " INITIAL QUESTION 1? " },
      { ...candidate(), question_text: "ＩＮＩＴＩＡＬ   QUESTION  １!" },
      { ...candidate(), question_text: 123 },
      { ...candidate(), question_type: "invalid taxonomy" },
      { ...candidate(), related_contexts: ["unselected"] },
      { ...candidate(), target: { type: "image", image_indices: [3], region: null } },
      { ...candidate(), target: { type: "region", image_indices: [1], region: { x: 0.9, y: 0, width: 0.3, height: 0.1 } } },
      { ...candidate(), target: { type: "multi_image", image_indices: [1, 1], region: null } },
    ];
    for (const invalid of invalids) {
      await rejected(f, stageSQL(r, invalid), /candidate|Duplicate|context|target|image|region|hierarchy|guides/i);
      assert.equal((await f.json(privateRead(r))).status, "dispatch_started");
    }
    await f.json(stageSQL(r, { ...candidate(), related_contexts: ["시각적·형태적 표현을 살펴보고 싶어요"] }));
    assert.deepEqual((await f.json(privateRead(r))).candidate.candidate.related_contexts, ["visual_form"]);
    assert.equal((await f.json(stageSQL(r))).staged, false);
    const before = await f.json(pinsSQL(f));
    const pins = await f.json(targetsSQL(f));
    // Inject a coupled commit failure and prove the whole swap rolls back.
    await f.exec(`create function public.local_regeneration_commit_fail() returns trigger language plpgsql as
      $$begin raise exception 'local injected target failure'; end;$$;
      create trigger zz_local_regeneration_commit_fail before insert on public.question_targets
      for each row execute function public.local_regeneration_commit_fail();`);
    await rejected(f, commitSQL(r), /injected target failure/);
    assert.deepEqual(await f.json(pinsSQL(f)), before);
    assert.deepEqual(await f.json(targetsSQL(f)), pins);
    assert.equal((await f.json(privateRead(r))).status, "staged");
    await f.exec("drop trigger zz_local_regeneration_commit_fail on public.question_targets; drop function public.local_regeneration_commit_fail();");
    await f.json(commitSQL(r));
    await rejected(f, `update public.question_regeneration_candidates set candidate='{}';`, /immutable/);
    await rejected(f, `delete from public.question_regeneration_events;`, /immutable/);
    await rejected(f, `update public.question_regeneration_attempts set dispatched_at=null,dispatch_expires_at=null;`, /immutable/);
    await rejected(f, `update public.questions set source_regeneration_candidate_id=null where source_regeneration_candidate_id is not null;`, /immutable/);
    const r2 = await f.json(beginSQL(f, f.questions[1]));
    await f.json(dispatchSQL(r2)); await f.json(stageSQL(r2, candidate("Another new angle?")));
    await f.exec(`${auth("authenticated")} update public.questions set status='skipped' where id=${quote(f.questions[2].id)};`);
    await rejected(f, commitSQL(r2), /snapshot changed/);
    assert.equal((await f.json(privateRead(r2))).status, "staged");
    await f.json(failSQL(r2, "QR-STALE"));
  } finally { await f.close(); }
});

test("API success max two, active owner/root/answer revision and cross-route identity defense", async () => {
  const f = await pgliteFixture();
  try {
    await f.exec(answerSQL(f.questions[0], ""));
    const revision = await f.json(`select to_jsonb(updated_at) as result from public.answers where question_id=${quote(f.questions[0].id)};`);
    await rejected(f, beginSQL(f), /revision changed/);
    let q = f.questions[0];
    const answerId = await f.json(`select to_jsonb(id) as result from public.answers where question_id=${quote(q.id)};`);
    for (let i = 0; i < 2; i++) {
      const r = await f.json(beginSQL(f, q, randomUUID(), i === 0 ? revision : null));
      await rejected(f, `${auth()} select public.apply_question_action(${quote(f.session)},${quote(f.questions[1].id)},
        ${quote(r.request_id)},'skip',${quote(owner)},null);`, /identity changed/);
      await f.json(dispatchSQL(r)); await f.json(stageSQL(r, candidate(`API success ${i + 1}?`)));
      const result = await f.json(commitSQL(r));
      q = (await f.json(pinsSQL(f))).find((row) => row.id === result.result_question_id);
    }
    assert.equal(q.regeneration_index, 2);
    await rejected(f, beginSQL(f, q), /limit reached/);
    assert.equal(await f.json(`select to_jsonb(question_id) as result from public.answers where id=${quote(answerId)};`), f.questions[0].id);
    await f.exec(answerSQL(f.questions[1], "Written"));
    const rev = await f.json(`select to_jsonb(updated_at) as result from public.answers where question_id=${quote(f.questions[1].id)};`);
    await rejected(f, beginSQL(f, f.questions[1], randomUUID(), rev), /Written answers/);
    await f.exec("update public.profiles set status='deactivated' where id=" + quote(owner));
    await rejected(f, beginSQL(f, f.questions[2]), /Active Participant/);
  } finally { await f.close(); }
});
