import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const owner = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const admin = "10000000-0000-4000-8000-000000000003";
const session = "20000000-0000-4000-8000-000000000001";
const request = "40000000-0000-4000-8000-000000000001";
const secondRequest = "40000000-0000-4000-8000-000000000002";
const generatedAt = "2026-10-08T00:00:00.000Z";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = (name) => read(`supabase/migrations/${name}`);

async function fixture(count = 3, deletion = true) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema extensions;
    alter default privileges for role postgres in schema public grant execute on functions to anon,authenticated,service_role;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as
      $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql as
      $$select current_setting('request.jwt.claim.role',true)$$;
    grant usage on schema auth,storage to authenticated,service_role;
    grant execute on all functions in schema auth to authenticated,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,
      metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant select,insert,update,delete on storage.objects to authenticated,service_role;
    create function storage.foldername(name text) returns text[] language sql immutable as
      $$select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]$$;
  `);
  await db.exec(migration("20261003201500_phase1_schema.sql").replace(
    "create extension if not exists pgcrypto with schema extensions;", ""));
  for (const name of ["20261003201600_phase1_rls.sql", "20261003233000_storage_upload_slots.sql",
    "20261004150000_participant_last_activity.sql", "20261005190000_session_context_save.sql",
    "20261005231000_context_draft_claim.sql"]) await db.exec(migration(name));
  if (deletion) await db.exec(migration("20261006031000_image_deletion.sql"));
  await db.exec(migration("20261008031500_question_generation_foundation.sql"));
  await db.exec(migration("20261008220000_answer_refinement_version.sql"));
  await db.exec(migration("20261009002000_question_actions.sql"));
  await db.exec(`
    insert into auth.users values ('${owner}'),('${other}'),('${admin}');
    insert into public.profiles(id,participant_code) values ('${owner}','P99001'),('${other}','P99002');
    insert into public.profiles(id,role) values ('${admin}','admin');
    insert into public.sessions(id,participant_id,requested_question_count) values ('${session}','${owner}',${count});
  `);
  const role = async (sql, params = [], who = owner, selectedRole = "authenticated") => {
    await db.exec(`set role ${selectedRole};
      select set_config('request.jwt.claim.sub','${who}',false),
        set_config('request.jwt.claim.role','${selectedRole}',false)`);
    try { return await db.query(sql, params); }
    finally { await db.exec("reset role; select set_config('request.jwt.claim.role','',false)"); }
  };
  const service = (sql, params) => role(sql, params, owner, "service_role");
  await role(`select public.save_session_context($1,'ux_ui','web_design',null,'idea_concept',
    'TEST saved context',array['visual_form','problem_and_goal'])`, [session]);
  const upload = async (n) => {
    const id = `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const slot = (await role("select * from public.reserve_image_upload($1,$2,'png',$3)",
      [session, id, "a".repeat(64)])).rows[0];
    await role(`insert into storage.objects(bucket_id,name,metadata)
      values('why-box-images',$1,'{"mimetype":"image/png","size":100}')`, [slot.storage_path]);
    await role(`insert into public.session_images(id,session_id,storage_path,original_filename,mime_type,
      file_size,width,height,sort_order) values($1,$2,$3,'TEST.png','image/png',100,800,600,$4)`,
    [id, session, slot.storage_path, slot.sort_order]);
    return { id, ...slot };
  };
  const images = [await upload(1), await upload(2)];
  const begin = async (id = request, who = owner) =>
    (await role("select public.begin_question_generation($1,$2) result", [session, id], who)).rows[0].result;
  const stage = (attempt, candidates = payload()) => service(`select public.stage_question_generation_candidates(
    $1,$2,$3::jsonb,'TEST-MOCK-MODEL','question-generation-v2.5','why_box_question_generation_v2_0',
    'v1.0',$4) changed`, [attempt.attempt_id, request, JSON.stringify(candidates), generatedAt]);
  const commit = async (attempt, id = request) =>
    (await service("select public.commit_question_generation($1,$2) result", [attempt.attempt_id, id])).rows[0].result;
  const fail = (attempt, code = "QGEN-API", id = request) =>
    service("select public.fail_question_generation($1,$2,$3) changed", [attempt.attempt_id, id, code]);
  const counts = async () => (await db.query(`select
    (select count(*)::int from public.question_candidates) candidates,
    (select count(*)::int from public.questions) questions,
    (select count(*)::int from public.question_targets) targets,
    (select status from public.sessions where id='${session}') session_status,
    (select status from public.question_generation_attempts order by started_at desc limit 1) attempt_status`)).rows[0];
  return { db, role, service, images, upload, begin, stage, commit, fail, counts };
}

function payload() {
  return Array.from({ length: 5 }, (_, i) => ({
    candidate_rank: i + 1,
    question_text: `TEST question ${i + 1}?`,
    content_principle: "사고의 자각과 외재화",
    question_type: "자기인식 질문",
    related_contexts: i === 0 ? ["시각적·형태적 표현을 살펴보고 싶어요"] : [],
    answer_guides: i === 0 ? ["TEST guide"] : [],
    target: i === 0
      ? { type: "region", image_indices: [2], region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }
      : i === 1 ? { type: "multi_image", image_indices: [2, 1], region: null }
        : { type: "image", image_indices: [1], region: null },
  }));
}

async function actionFixture(n=3) {
  const f=await fixture(n);
  const attempt=await f.begin();await f.stage(attempt);await f.commit(attempt);
  f.active=async()=> (await f.role(`select id,slot_index,status,regeneration_index,source_candidate_id
    from public.questions where session_id=$1 and is_active_version order by slot_index`,[session])).rows;
  f.action=async(id,action,requestId="70000000-0000-4000-8000-000000000001",actor=owner,revision=null)=>
    (await f.service("select public.apply_question_action($1,$2,$3,$4,$5,$6) result",
      [session,id,requestId,action,actor,revision])).rows[0].result;
  return f;
}

test("skip persists without removing targets, is idempotent and preserves answer/history contracts",async()=>{
  const f=await actionFixture();
  try {
    const [first,second]=await f.active();
    const before=(await f.role("select * from public.question_targets where question_id=$1",[first.id])).rows;
    assert.equal((await f.action(first.id,"skip")).changed,true);
    assert.equal((await f.action(first.id,"skip")).changed,false);
    assert.equal((await f.action(first.id,"skip","70000000-0000-4000-8000-000000000002")).changed,false);
    assert.equal((await f.active())[0].status,"skipped");
    assert.deepEqual((await f.role("select * from public.question_targets where question_id=$1",[first.id])).rows,before);
    assert.equal((await f.db.query("select count(*)::int n from public.question_events")).rows[0].n,1);
    await assert.rejects(f.role("insert into public.answers(question_id,participant_id,original_answer) values($1,$2,'TEST denied')",[first.id,owner]));
    await f.role("insert into public.answers(question_id,participant_id,original_answer) values($1,$2,'TEST retained')",[second.id,owner]);
    const revision=(await f.role("select updated_at::text from public.answers where question_id=$1",[second.id])).rows[0].updated_at;
    await assert.rejects(f.action(second.id,"skip","70000000-0000-4000-8000-000000000003",owner,revision),e=>e.code==="55000");
    assert.equal((await f.role("select original_answer from public.answers where question_id=$1",[second.id])).rows[0].original_answer,"TEST retained");
    await assert.rejects(f.action(second.id,"skip","70000000-0000-4000-8000-000000000004",other),e=>e.code==="42501");
    await assert.rejects(f.role("select public.apply_question_action($1,$2,$3,'skip',$4,null)",
      [session,second.id,"70000000-0000-4000-8000-000000000005",owner]),e=>e.code==="42501");
  } finally {await f.db.close();}
});

for(const n of [1,3,5]) test(`N=${n}: reserve replacement preserves slot/lineage and never reuses candidates`,async()=>{
  const f=await actionFixture(n);
  try {
    const first=(await f.active())[0];
    const original=(await f.role("select * from public.questions where id=$1",[first.id])).rows[0];
    const caps=(await f.role("select public.read_question_action_capabilities($1) caps",[session])).rows[0].caps;
    assert.deepEqual(caps,{ready:true,reserve_count:5-n});
    if(n===5) {
      await assert.rejects(f.action(first.id,"regenerate"),e=>e.code==="P0002");
      assert.equal((await f.active())[0].id,first.id);return;
    }
    const changed=await f.action(first.id,"regenerate");
    assert.equal(changed.changed,true);
    const duplicate=await f.action(first.id,"regenerate");
    assert.equal(duplicate.result_question_id,changed.result_question_id);assert.equal(duplicate.changed,false);
    await assert.rejects(f.action(first.id,"regenerate","70000000-0000-4000-8000-000000000002"),e=>e.code==="40001");
    let active=await f.active();
    assert.equal(active.length,n);assert.equal(active[0].slot_index,1);assert.equal(active[0].regeneration_index,1);
    let replacement=(await f.role("select * from public.questions where id=$1",[active[0].id])).rows[0];
    assert.equal(replacement.root_question_id,first.id);assert.equal(replacement.parent_question_id,first.id);
    assert.equal(replacement.selection_reason,`system:reserve_replacement;candidate_rank=${n+1};slot_index=1`);
    assert.equal(replacement.question_text,`TEST question ${n+1}?`);
    assert.equal((await f.role("select image_id from public.question_targets where question_id=$1 order by sort_order",[active[0].id])).rows[0].image_id,
      n===1?f.images[1].id:f.images[0].id);
    assert.deepEqual((await f.role("select * from public.questions where id=$1",[first.id])).rows[0],{...original,is_active_version:false});
    const skippedParent=active[0].id;
    await f.action(skippedParent,"skip","70000000-0000-4000-8000-000000000003");
    await f.action(skippedParent,"regenerate","70000000-0000-4000-8000-000000000004");
    active=await f.active();assert.equal(active[0].regeneration_index,2);
    const eventCount=(await f.db.query("select count(*)::int n from public.question_events")).rows[0].n;
    assert.deepEqual(await f.action(first.id,"regenerate"),duplicate);
    const skippedReplay=await f.action(skippedParent,"skip","70000000-0000-4000-8000-000000000003");
    assert.equal(skippedReplay.result_question_id,skippedParent);assert.equal(skippedReplay.changed,false);
    assert.equal((await f.db.query("select count(*)::int n from public.question_events")).rows[0].n,eventCount);
    assert.equal((await f.active())[0].id,active[0].id);
    assert.equal((await f.role("select status from public.questions where id=$1",[skippedParent])).rows[0].status,"skipped");
    await assert.rejects(f.action(active[0].id,"regenerate","70000000-0000-4000-8000-000000000005"),e=>e.code==="54000");
    assert.equal((await f.db.query("select count(*)::int n from public.question_candidates")).rows[0].n,5);
    assert.equal((await f.db.query("select count(distinct source_candidate_id)::int n,count(*)::int total from public.questions")).rows[0].n,n+2);
    await assert.rejects(f.role("delete from public.question_action_requests"),e=>e.code==="42501");
    await assert.rejects(f.service("update public.question_action_requests set action='skip'"),e=>e.code==="42501");
  } finally {await f.db.close();}
});

test("replacement rollback on target failure, stale answer denial, used reserve exhaustion and read-only session",async()=>{
  const f=await actionFixture(3);
  try {
    const [first,second,third]=await f.active();
    await f.db.exec(`create function public.test_reject_replacement_target() returns trigger language plpgsql as $$
      begin raise exception 'TEST target failure'; end; $$;
      create trigger test_replacement_fail before insert on public.question_targets
      for each row execute function public.test_reject_replacement_target();`);
    await assert.rejects(f.action(first.id,"regenerate"));
    assert.equal((await f.active())[0].id,first.id);
    assert.equal((await f.db.query("select count(*)::int n from public.question_action_requests")).rows[0].n,0);
    await f.db.exec("drop trigger test_replacement_fail on public.question_targets");
    await f.role("insert into public.answers(question_id,participant_id,original_answer) values($1,$2,'')",[first.id,owner]);
    await assert.rejects(f.action(first.id,"regenerate"),e=>e.code==="40001");
    const revision=(await f.role("select updated_at::text from public.answers where question_id=$1",[first.id])).rows[0].updated_at;
    await f.action(first.id,"regenerate","70000000-0000-4000-8000-000000000001",owner,revision);
    assert.equal((await f.role("select question_id from public.answers where question_id=$1",[first.id])).rows[0].question_id,first.id);
    await f.action(second.id,"regenerate","70000000-0000-4000-8000-000000000002");
    await assert.rejects(f.action(third.id,"regenerate","70000000-0000-4000-8000-000000000003"),e=>e.code==="P0002");
    const active=await f.active();
    await f.role("insert into public.answers(question_id,participant_id,original_answer) values($1,$2,'TEST completed answer')",
      [active[0].id,owner]);
    for(const question of active.slice(1))await f.action(question.id,"skip",
      `70000000-0000-4000-8000-${String(question.slot_index+10).padStart(12,"0")}`);
    await f.db.exec(`update public.sessions set status='summary_ready' where id='${session}';
      update public.sessions set status='completed',summary_text='TEST synthetic summary' where id='${session}'`);
    await assert.rejects(f.action(third.id,"skip","70000000-0000-4000-8000-000000000004"),e=>e.code==="55000");
  } finally {await f.db.close();}
});

test("saved question-count updates return authoritative 1..5 under caller RLS and unlock only after failure", async () => {
  const f = await fixture();
  try {
    for (const n of [1, 2, 3, 4, 5]) {
      const changed = await f.role("update public.sessions set requested_question_count=$2 where id=$1 returning requested_question_count",
        [session, n]);
      assert.equal(changed.rows[0].requested_question_count, n);
    }
    const foreign = await f.role("update public.sessions set requested_question_count=1 where id=$1 returning requested_question_count",
      [session], other);
    assert.equal(foreign.rows.length, 0);
    const attempt = await f.begin();
    const locked = await f.role("update public.sessions set requested_question_count=1 where id=$1 returning requested_question_count",
      [session]);
    assert.equal(locked.rows.length, 0);
    await f.fail(attempt);
    const unlocked = await f.role("update public.sessions set requested_question_count=3 where id=$1 returning requested_question_count",
      [session]);
    assert.equal(unlocked.rows[0].requested_question_count, 3);
  } finally { await f.db.close(); }
});

test("answer schema preserves authored/refined text and persists undo under participant RLS", async()=>{
  const f=await fixture();
  try {
    const attempt=await f.begin();
    await f.stage(attempt);
    await f.commit(attempt);
    const questionId=(await f.role("select id from public.questions where session_id=$1 order by slot_index limit 1",
      [session])).rows[0].id;
    await f.role("insert into public.answers(question_id,participant_id,original_answer) values($1,$2,'TEST original')",
      [questionId,owner]);
    let row=(await f.role("select original_answer,refined_answer,refinement_used,current_answer_version from public.answers where question_id=$1",
      [questionId])).rows[0];
    assert.deepEqual(row,{original_answer:"TEST original",refined_answer:null,refinement_used:false,current_answer_version:"original"});
    await f.role("update public.answers set original_answer='TEST updated original' where question_id=$1",[questionId]);
    assert.equal((await f.role("select status from public.questions where id=$1",[questionId])).rows[0].status,"answered");
    await f.role("update public.answers set original_answer='' where question_id=$1",[questionId]);
    assert.equal((await f.role("select status from public.questions where id=$1",[questionId])).rows[0].status,"unprocessed");
    await f.role("update public.answers set original_answer='TEST original' where question_id=$1",[questionId]);
    await f.role(`update public.answers set refined_answer='TEST refined',refinement_used=true,
      refined_at=now(),current_answer_version='refined' where question_id=$1`,[questionId]);
    row=(await f.role("select original_answer,refined_answer,refinement_used,current_answer_version from public.answers where question_id=$1",
      [questionId])).rows[0];
    assert.deepEqual(row,{original_answer:"TEST original",refined_answer:"TEST refined",refinement_used:true,current_answer_version:"refined"});
    await f.role("update public.answers set current_answer_version='original' where question_id=$1",[questionId]);
    row=(await f.role("select original_answer,refined_answer,refinement_used,current_answer_version from public.answers where question_id=$1",
      [questionId])).rows[0];
    assert.deepEqual(row,{original_answer:"TEST original",refined_answer:"TEST refined",refinement_used:true,current_answer_version:"original"});
    const foreign=await f.role("select question_id from public.answers where question_id=$1",[questionId],other);
    assert.equal(foreign.rows.length,0);
    const denied=await f.role("update public.answers set current_answer_version='refined' where question_id=$1",[questionId],other);
    assert.equal(denied.rowCount,0);
  } finally {await f.db.close();}
});

test("Frozen schema retains approved SHA-256; CTA uses eligibility with server-only route", () => {
  for (const [path, hash] of [
    ["src/lib/ai/schemas/question-generation-v2.0.ts", "0fe9c5ce02cbe5cdc03415b7b8d68c58ca049d40a6a4d6d192ebd454b3833d49"],
  ]) assert.equal(createHash("sha256").update(read(path)).digest("hex"), hash);
  assert.match(read("src/app/(participant)/sessions/[sessionId]/session-wizard.tsx"),
    /disabled=\{!eligible\} onClick=\{\(\) => void controller\.current\?\.start\(\)\}>질문 생성하기<\/button>/);
  assert.equal(existsSync(new URL("../src/app/api/question-generation/route.ts", import.meta.url)), true);
});

for (const count of [1, 3, 5]) test(`N=${count}: five immutable candidates, top N originals/targets and atomic status`, async () => {
  const f = await fixture(count);
  try {
    const attempt = await f.begin();
    assert.equal(attempt.acquired, true);
    const snapshot = (await f.db.query("select * from public.question_generation_attempts")).rows[0];
    assert.equal(snapshot.input_snapshot.additional_context, "TEST saved context");
    assert.deepEqual(snapshot.image_snapshot.map((image) => image.id), f.images.map((image) => image.id));
    assert.equal(snapshot.requested_question_count, count);
    assert.equal((await f.stage(attempt)).rows[0].changed, true);
    assert.equal((await f.stage(attempt)).rows[0].changed, false);
    assert.equal((await f.commit(attempt)).saved, true);
    assert.deepEqual(await f.counts(), { candidates: 5, questions: count, targets: count === 1 ? 1 : count + 1,
      session_status: "in_progress", attempt_status: "completed" });
    const actual = (await f.db.query(`select q.slot_index,q.question_kind,q.root_question_id=q.id root_self,
      q.regeneration_index,q.is_active_version,q.status,q.selection_reason,c.candidate_rank,
      c.related_contexts,c.context_ids,c.answer_guides,c.schema_version,q.generated_at=c.generated_at timestamp_matches
      from public.questions q join public.question_candidates c on c.id=q.source_candidate_id order by q.slot_index`)).rows;
    assert.deepEqual(actual.map((row) => row.candidate_rank), Array.from({ length: count }, (_, i) => i + 1));
    for (const row of actual) {
      assert.equal(row.question_kind, "original");
      assert.equal(row.root_self, true);
      assert.equal(row.regeneration_index, 0);
      assert.equal(row.is_active_version, true);
      assert.equal(row.status, "unprocessed");
      assert.equal(row.timestamp_matches, true);
      assert.equal(row.schema_version, "why_box_question_generation_v2_0");
      assert.equal(row.selection_reason, `system:initial_top_n;candidate_rank=${row.slot_index};requested_question_count=${count}`);
    }
    assert.deepEqual(actual[0].related_contexts, ["시각적·형태적 표현을 살펴보고 싶어요"]);
    assert.deepEqual(actual[0].context_ids, ["visual_form"]);
    assert.deepEqual(actual[0].answer_guides, ["TEST guide"]);
    const targets = (await f.db.query(`select q.slot_index,t.image_id,t.x,t.y,t.width,t.height,t.sort_order
      from public.questions q join public.question_targets t on t.question_id=q.id order by q.slot_index,t.sort_order`)).rows;
    assert.deepEqual(targets[0], { slot_index: 1, image_id: f.images[1].id, x: 0.1, y: 0.2,
      width: 0.3, height: 0.4, sort_order: 0 });
    if (count > 1) assert.deepEqual(targets.slice(1, 3).map((t) => t.image_id), [f.images[1].id, f.images[0].id]);
    assert.equal((await f.begin()).acquired, false);
    assert.equal((await f.begin(secondRequest)).status, "completed");
    assert.equal((await f.commit(attempt)).saved, false);
    assert.equal((await f.fail(attempt)).rows[0].changed, false);
    assert.equal((await f.role("select count(*)::int n from public.question_candidates")).rows[0].n, 5);
    assert.equal((await f.role("select count(*)::int n from public.question_candidates", [], other)).rows[0].n, 0);
    assert.equal((await f.role("select count(*)::int n from public.question_candidates", [], admin)).rows[0].n, 5);
    await assert.rejects(f.service("update public.question_candidates set question_text='changed'"), /permission denied/);
    await assert.rejects(f.db.query("update public.question_candidates set question_text='changed'"), /immutable/);
    await assert.rejects(f.db.query("update public.questions set source_candidate_id=null"), /immutable/);
    await assert.rejects(f.db.query("update public.questions set selection_reason='AI guessed reason'"), /immutable/);
    await assert.rejects(f.role("update public.sessions set requested_question_count=2 where id=$1", [session]), /immutable/);
    await assert.rejects(f.db.query("update public.sessions set status='completed'"), /transition|forward|adjacent|state|summary/i);
  } finally { await f.db.close(); }
});

test("begin queued requests: same/different request IDs obtain exactly one execution right", async () => {
  const f = await fixture();
  try {
    // PGlite queues one connection; this verifies conflicting claims, not independent connection lock waits.
    await f.db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${owner}',false),
      set_config('request.jwt.claim.role','authenticated',false)`);
    const results = await Promise.all([request, secondRequest, request].map((id) =>
      f.db.query("select public.begin_question_generation($1,$2) result", [session, id])));
    assert.equal(results.filter((r) => r.rows[0].result.acquired).length, 1);
    assert.equal(new Set(results.map((r) => r.rows[0].result.attempt_id)).size, 1);
    await f.db.exec("reset role; select set_config('request.jwt.claim.role','',false)");
    assert.equal((await f.db.query("select count(*)::int n from public.question_generation_attempts")).rows[0].n, 1);
  } finally { await f.db.close(); }
});

test("active attempt freezes every input/image path, failure releases lock, retry is explicit", async () => {
  const f = await fixture();
  try {
    const claim = (manual) => f.role(
      "select public.claim_context_draft($1,$2,'ux_ui','web_design',null,'idea_concept',array['visual_form']) claimed",
      [session, manual]);
    assert.equal((await claim(false)).rows[0].claimed, false);
    const marker = (await f.db.query("select context_draft_auto_claimed_at::text from public.sessions")).rows[0].context_draft_auto_claimed_at;
    assert.ok(marker);
    const attempt = await f.begin();
    assert.equal((await f.role("select public.can_edit_session_context($1) editable", [session])).rows[0].editable, false);
    await assert.rejects(f.role(`select public.save_session_context($1,'ux_ui','web_design',null,'idea_concept',
      'TEST saved context',array['visual_form','problem_and_goal'])`, [session]), /access denied/);
    for (const [sql, params] of [
      ["update public.sessions set additional_context='changed' where id=$1", [session]],
      ["update public.sessions set requested_question_count=1 where id=$1", [session]],
      ["update public.sessions set primary_category_id='others',subcategory_id='other',other_category_text='TEST' where id=$1", [session]],
      ["update public.sessions set stage_id='review_improvement' where id=$1", [session]],
      ["delete from public.session_contexts where session_id=$1", [session]],
      ["insert into public.session_contexts(session_id,context_id) values($1,'design_concept')", [session]],
      ["update public.session_contexts set context_id='design_concept' where session_id=$1 and context_id='visual_form'", [session]],
      ["update public.session_images set sort_order=9 where id=$1", [f.images[0].id]],
      ["delete from public.session_images where id=$1", [f.images[0].id]],
      ["delete from storage.objects where name=$1", [f.images[0].storage_path]],
      ["update storage.objects set metadata='{}' where name=$1", [f.images[0].storage_path]],
      ["select * from public.reserve_image_upload($1,$2,'png',$3)", [session, secondRequest, "a".repeat(64)]],
      ["select * from public.begin_image_deletion($1,$2)", [session, f.images[0].id]],
      ["select public.save_session_context($1,'ux_ui','web_design',null,'idea_concept','changed',array['visual_form'])", [session]],
    ]) {
      await assert.rejects(f.service(sql, params), /locked|permission|denied|read-only/i);
      if (!sql.startsWith("select ")) await assert.rejects(f.db.query(sql, params), /locked/);
    }
    await assert.rejects(f.upload(3), /locked|denied|row-level/);
    for (const manual of [false, true]) await assert.rejects(f.role(
      "select public.claim_context_draft($1,$2,'ux_ui','web_design',null,'idea_concept',array['visual_form'])",
      [session, manual]), /denied/);
    assert.equal((await f.fail(attempt, "QGEN-STALE")).rows[0].changed, true);
    assert.equal((await f.begin()).status, "failed");
    assert.equal((await f.role("select public.can_edit_session_context($1) editable", [session])).rows[0].editable, true);
    assert.equal((await claim(false)).rows[0].claimed, false);
    assert.equal((await claim(true)).rows[0].claimed, true);
    assert.equal((await f.db.query("select context_draft_auto_claimed_at::text from public.sessions")).rows[0].context_draft_auto_claimed_at, marker);
    await assert.rejects(f.role("update public.sessions set context_draft_auto_claimed_at=null where id=$1", [session]), /reset or changed/);
    assert.equal((await f.role(`select public.save_session_context($1,'ux_ui','web_design',null,
      'review_improvement','edited after failure',array['visual_form']) changed`, [session])).rows[0].changed, true);
    await f.role("update public.sessions set requested_question_count=1 where id=$1", [session]);
    await f.upload(3);
    await f.role("select * from public.begin_image_deletion($1,$2)", [session, f.images[0].id]);
    await f.role("delete from storage.objects where name=$1", [f.images[0].storage_path]);
    await f.role("select public.finish_image_deletion($1,$2)", [session, f.images[0].id]);
    const retry = await f.begin(secondRequest);
    assert.equal(retry.acquired, true);
    assert.notEqual(retry.attempt_id, attempt.attempt_id);
    const snapshot = (await f.db.query("select input_snapshot,requested_question_count from public.question_generation_attempts where id=$1",
      [retry.attempt_id])).rows[0];
    assert.equal(snapshot.input_snapshot.additional_context, "edited after failure");
    assert.equal(snapshot.requested_question_count, 1);
  } finally { await f.db.close(); }
});

const invalid = [
  ["four", (p) => p.slice(0, 4)],
  ["six", (p) => [...p, p[0]]],
  ["duplicate rank", (p) => { p[4].candidate_rank = 1; return p; }],
  ["missing rank", (p) => { delete p[2].candidate_rank; return p; }],
  ["rank order", (p) => p.reverse()],
  ["bad target type", (p) => { p[0].target.type = "unknown"; return p; }],
  ["image out of range", (p) => { p[0].target.image_indices = [3]; return p; }],
  ["duplicate image", (p) => { p[1].target.image_indices = [1, 1]; return p; }],
  ["noninteger image", (p) => { p[0].target.image_indices = [1.1]; return p; }],
  ["invalid related context", (p) => { p[0].related_contexts = ["design_concept"]; return p; }],
  ["duplicate context alias", (p) => { p[0].related_contexts.push("visual_form"); return p; }],
  ["no top N context", (p) => { p[0].related_contexts = []; return p; }],
  ["invalid guide", (p) => { p[0].answer_guides = [null]; return p; }],
  ["empty question", (p) => { p[0].question_text = " "; return p; }],
  ["duplicate question", (p) => { p[4].question_text = p[0].question_text; return p; }],
  ["invalid hierarchy", (p) => { p[0].question_type = "자기변화 관찰 질문"; return p; }],
  ["region outside image", (p) => { p[0].target.region.width = 1; return p; }],
  ["zero region", (p) => { p[0].target.region.width = 0; return p; }],
  ["null region", (p) => { p[0].target.region = null; return p; }],
  ["non-null whole image region", (p) => { p[2].target.region = p[0].target.region; return p; }],
  ["extra target field", (p) => { p[0].target.signed_url = "FORBIDDEN"; return p; }],
  ["extra candidate field", (p) => { p[0].selection_reason = "FORBIDDEN"; return p; }],
  ["null payload", () => null],
];

test("invalid candidates cannot stage or commit; no partial candidates/questions/targets", async () => {
  const f = await fixture(1);
  try {
    const attempt = await f.begin();
    for (const [name, mutate] of invalid) {
      await assert.rejects(f.stage(attempt, mutate(payload())), { code: "22023" }, name);
      await assert.rejects(f.commit(attempt), /cannot commit/, name);
      assert.deepEqual(await f.counts(), { candidates: 0, questions: 0, targets: 0,
        session_status: "draft", attempt_status: "running" }, name);
    }
    await f.stage(attempt);
    const changed = payload(); changed[0].question_text = "Changed response";
    await assert.rejects(f.stage(attempt, changed), /immutable/);
    await assert.rejects(f.service("select public.fail_question_generation($1,$2,'raw-secret-error')",
      [attempt.attempt_id, request]), /safe failure code/);
    await f.commit(attempt);
  } finally { await f.db.close(); }
});

for (const [name, table, condition] of [
  ["candidate", "public.question_candidates", "new.candidate_rank=4"],
  ["question", "public.questions", "new.slot_index=3"],
  ["target", "public.question_targets", "new.sort_order=1"],
  ["status", "public.sessions", "new.status='in_progress'"],
]) test(`injected ${name} failure rolls back entire commit; staged output recovers without new generation`, async () => {
  const f = await fixture();
  try {
    const attempt = await f.begin(); await f.stage(attempt);
    await f.db.exec(`create function public.test_injected_failure() returns trigger language plpgsql as $$
      begin if ${condition} then raise exception 'TEST injected ${name} failure'; end if; return new; end $$;
      create trigger zz_test_failure before insert or update on ${table}
        for each row execute function public.test_injected_failure()`);
    await assert.rejects(f.commit(attempt), new RegExp(`TEST injected ${name} failure`));
    assert.deepEqual(await f.counts(), { candidates: 0, questions: 0, targets: 0, session_status: "draft", attempt_status: "running" });
    const snapshot = (await f.db.query("select validated_candidates,failed_at from public.question_generation_attempts")).rows[0];
    assert.deepEqual(snapshot.validated_candidates, payload());
    assert.equal(snapshot.failed_at, null);
    assert.equal((await f.begin()).acquired, false);
    await f.db.exec(`drop trigger zz_test_failure on ${table}; drop function public.test_injected_failure()`);
    assert.equal((await f.commit(attempt)).saved, true);
    assert.equal((await f.commit(attempt)).saved, false);
    const stored = (await f.role(`select q.question_text,c.candidate_rank from public.questions q
      join public.question_candidates c on c.id=q.source_candidate_id order by q.slot_index`)).rows;
    assert.equal(stored.length, 3);
  } finally { await f.db.close(); }
});

test("authorization, failed attempt rejection, existing questions guard and deployed baseline compatibility", async () => {
  const f = await fixture(3, false);
  try {
    await assert.rejects(f.begin(request, other), /access denied/);
    await assert.rejects(f.begin(request, admin), /access denied/);
    await f.db.exec(`update public.profiles set status='deactivated' where id='${owner}'`);
    await assert.rejects(f.begin(), /access denied|Active Participant/);
    await f.db.exec(`update public.profiles set status='active' where id='${owner}'`);
    const attempt = await f.begin();
    for (const [sql, params] of [
      ["select public.commit_question_generation($1,$2)", [attempt.attempt_id, request]],
      ["select public.fail_question_generation($1,$2,'QGEN-API')", [attempt.attempt_id, request]],
      ["update public.question_generation_attempts set status='failed'", []],
      ["delete from public.question_generation_attempts", []],
      ["select public.question_generation_snapshot($1)", [session]],
    ]) await assert.rejects(f.role(sql, params), /permission denied/);
    const grants = (await f.db.query(`select
      has_function_privilege('anon','public.begin_question_generation(uuid,uuid)','EXECUTE') anon_begin,
      has_function_privilege('authenticated','public.commit_question_generation(uuid,uuid)','EXECUTE') participant_commit,
      has_function_privilege('service_role','public.commit_question_generation(uuid,uuid)','EXECUTE') server_commit,
      has_table_privilege('service_role','public.question_candidates','INSERT') server_direct_insert`)).rows[0];
    assert.deepEqual(grants, { anon_begin: false, participant_commit: false, server_commit: true, server_direct_insert: false });
    await assert.rejects(f.service("select public.commit_question_generation($1,$2)", [attempt.attempt_id, secondRequest]), /not found/);
    await f.fail(attempt);
    await assert.rejects(f.stage(attempt), /not running/);
    await assert.rejects(f.commit(attempt), /cannot commit/);
    const retry = await f.begin(secondRequest);
    await f.service(`select public.stage_question_generation_candidates($1,$2,$3::jsonb,'TEST-MOCK-MODEL',
      'question-generation-v2.5','why_box_question_generation_v2_0','v1.0',$4)`,
    [retry.attempt_id, secondRequest, JSON.stringify(payload()), generatedAt]);
    await f.commit(retry, secondRequest);
    await assert.rejects(f.role(`select public.save_session_context($1,'ux_ui','web_design',null,
      'idea_concept','changed',array['visual_form'])`, [session]), /read-only/);
    // Existing deferred target and active-version guards are still in force.
    await assert.rejects(f.db.exec("update public.questions set is_active_version=false where slot_index=1"), /active/);
    await assert.rejects(f.db.exec("delete from public.question_targets"), /cannot be deleted/);
  } finally { await f.db.close(); }
});

test("begin rejects incomplete input, unresolved upload, and pending optional deletion", async () => {
  const f = await fixture();
  try {
    await f.role("update public.sessions set stage_id=null where id=$1", [session]);
    await assert.rejects(f.begin(), /Invalid saved/);
    await f.role("update public.sessions set stage_id='idea_concept' where id=$1", [session]);
    const pendingUpload = (await f.role("select * from public.reserve_image_upload($1,$2,'png',$3)",
      [session, secondRequest, "a".repeat(64)])).rows[0];
    await assert.rejects(f.begin(), /Unresolved image upload/);
    await f.role(`insert into storage.objects(bucket_id,name,metadata)
      values('why-box-images',$1,'{"mimetype":"image/png","size":100}')`, [pendingUpload.storage_path]);
    await f.role(`insert into public.session_images(session_id,storage_path,original_filename,mime_type,file_size,sort_order)
      values($1,$2,'TEST.png','image/png',100,$3)`, [session, pendingUpload.storage_path, pendingUpload.sort_order]);
    await f.role("select * from public.begin_image_deletion($1,$2)", [session, f.images[0].id]);
    await assert.rejects(f.begin(), /Pending image deletion/);
    assert.equal((await f.db.query("select count(*)::int n from public.question_generation_attempts")).rows[0].n, 0);
  } finally { await f.db.close(); }
});

test("staging/commit reject deactivation and snapshot mismatch; old result cannot commit after failure", async () => {
  const f = await fixture();
  try {
    const attempt = await f.begin();
    await f.db.query("update public.profiles set status='deactivated' where id=$1", [owner]);
    await assert.rejects(f.stage(attempt), /Active Participant/);
    await f.db.query("update public.profiles set status='active' where id=$1", [owner]);
    await f.stage(attempt);
    await f.db.query("update public.profiles set status='deactivated' where id=$1", [owner]);
    await assert.rejects(f.commit(attempt), /Active Participant/);
    await f.db.query("update public.profiles set status='active' where id=$1", [owner]);
    // Simulate privileged corruption only inside this disposable database, not a permitted input path.
    await f.db.exec("alter table public.sessions disable trigger a_question_generation_input_guard");
    await f.db.query("update public.sessions set additional_context='TEST snapshot mismatch' where id=$1", [session]);
    await f.db.exec("alter table public.sessions enable trigger a_question_generation_input_guard");
    await assert.rejects(f.stage(attempt), { code: "40001" });
    await assert.rejects(f.commit(attempt), { code: "40001" });
    assert.deepEqual(await f.counts(), { candidates: 0, questions: 0, targets: 0, session_status: "draft", attempt_status: "running" });
    await f.fail(attempt, "QGEN-COMMIT");
    assert.equal((await f.begin()).status, "failed");
    await assert.rejects(f.commit(attempt), /cannot commit/);
    assert.equal((await f.begin(secondRequest)).acquired, true);
  } finally { await f.db.close(); }
});
