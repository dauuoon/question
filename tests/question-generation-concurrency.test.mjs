import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import process from "node:process";
import console from "node:console";

// Deliberately no DATABASE_URL or project credentials: this suite only targets a disposable loopback cluster.
const psql = process.env.PG_TEST_PSQL ?? "/opt/homebrew/opt/postgresql@17/bin/psql";
const port = process.env.PG_TEST_PORT ?? "55439";
assert.match(port, /^\d{4,5}$/);
const database = `why_box_concurrency_${process.pid}`;
const owner = "10000000-0000-4000-8000-000000000001";
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const records = (result) => result.out.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

function run(sql, name = "observer", db = database) {
  const child = spawn(psql, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1",
    "-p", port, "-U", "postgres", "-d", db], {
    env: { ...process.env, LC_ALL: "C", PGAPPNAME: name, PGCONNECT_TIMEOUT: "5" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = ""; let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ ok: code === 0, out, err }));
    child.stdin.end(`set statement_timeout='12s'; set lock_timeout='8s';\n${sql}`);
  });
}

async function exec(sql, name, db) {
  const result = await run(sql, name, db);
  assert.equal(result.ok, true, result.err);
  return result;
}
function auth(role = "authenticated") {
  return `set role ${role}; select set_config('request.jwt.claim.sub',${quote(owner)},false),
    set_config('request.jwt.claim.role',${quote(role)},false);`;
}
const beginSQL = (session, request) =>
  `select public.begin_question_generation(${quote(session)},${quote(request)})::text;`;
const failSQL = (attempt, request) =>
  `select public.fail_question_generation(${quote(attempt)},${quote(request)},'QGEN-STALE');`;

async function waitFor(sql, predicate, label) {
  for (let i = 0; i < 50; i++) {
    const rows = records(await exec(sql));
    if (predicate(rows)) return rows;
    await delay(30);
  }
  assert.fail(`Missing actual PostgreSQL evidence: ${label}`);
}
async function hold(sql, name, role = "authenticated") {
  const pending = run(`begin; ${auth(role)} ${sql} select pg_sleep(3); commit;`, name);
  await waitFor(`select json_build_object('pid',pid,'wait',wait_event)::text from pg_stat_activity
    where application_name=${quote(name)} and datname=${quote(database)};`,
  (rows) => rows.some((row) => row.wait === "PgSleep"), `${name} entered transaction hold`);
  return { pending };
}
async function blocked(names) {
  const rows = await waitFor(`select json_build_object('name',application_name,'pid',pid,
    'blockers',pg_blocking_pids(pid),'transaction',xact_start)::text from pg_stat_activity
    where datname=${quote(database)} and application_name in (${names.map(quote).join(",")});`,
  (rows) => rows.length === names.length && rows.every((row) => row.blockers.length > 0), "independent blocked backends");
  assert.equal(new Set(rows.map((row) => row.pid)).size, names.length);
  console.log(`POSTGRESQL_LOCK_EVIDENCE ${JSON.stringify(rows)}`);
  return rows;
}

async function fixture() {
  const session = randomUUID();
  await exec(`insert into public.sessions(id,participant_id) values(${quote(session)},${quote(owner)});`);
  await exec(`${auth()} select public.save_session_context(${quote(session)},'ux_ui','web_design',null,
    'idea_concept','TEST saved context',array['visual_form']);`);
  async function upload() {
    const id = randomUUID();
    const slot = records(await exec(`${auth()} select row_to_json(u)::text from
      public.reserve_image_upload(${quote(session)},${quote(id)},'png',${quote("a".repeat(64))}) u;`))[0];
    await exec(`${auth()} insert into storage.objects(bucket_id,name,metadata)
      values('why-box-images',${quote(slot.storage_path)},'{"mimetype":"image/png","size":100}');
      insert into public.session_images(id,session_id,storage_path,original_filename,mime_type,file_size,width,height,sort_order)
      values(${quote(id)},${quote(session)},${quote(slot.storage_path)},'TEST.png','image/png',100,800,600,${slot.sort_order});`);
    return { id, ...slot };
  }
  return { session, upload, images: [await upload(), await upload()] };
}
function payload() {
  return Array.from({ length: 5 }, (_, i) => ({
    candidate_rank: i + 1, question_text: `TEST ${i + 1}?`,
    content_principle: "사고의 자각과 외재화", question_type: "자기인식 질문",
    related_contexts: i === 0 ? ["visual_form"] : [], answer_guides: [],
    target: { type: i === 1 ? "multi_image" : "image", image_indices: i === 1 ? [2, 1] : [1], region: null },
  }));
}

test("native PostgreSQL independent connection and ordered migration verification",
  { skip: process.env.PG_TEST_ENABLED !== "1" }, async (t) => {
  let created = false;
  try {
    const existingRoles = records(await exec(`select json_build_object('count',count(*))::text
      from pg_roles where rolname in ('anon','authenticated','service_role');`, "setup", "postgres"))[0];
    assert.equal(existingRoles.count, 0, "Use a dedicated fresh cluster, never an existing Supabase/local application cluster");
    await exec(`create database ${database};`, "setup", "postgres"); created = true;
    // Reuse the isolated Auth/Storage catalog fixture, never any production rows or credentials.
    const fixtureSQL = read("tests/question-generation-db.test.mjs").match(/await db.exec\(`([\s\S]*?)`\);/)[1];
    await exec(fixtureSQL);
    for (const file of ["20261003201500_phase1_schema.sql", "20261003201600_phase1_rls.sql",
      "20261003233000_storage_upload_slots.sql", "20261004150000_participant_last_activity.sql",
      "20261005190000_session_context_save.sql", "20261005231000_context_draft_claim.sql",
      "20261006031000_image_deletion.sql", "20261008031500_question_generation_foundation.sql"]) {
      await exec(read(`supabase/migrations/${file}`));
      console.log(`APPLIED_LOCAL_ONLY ${file}`);
      if (file === "20261005231000_context_draft_claim.sql") {
        const fingerprint = await exec(`select jsonb_build_object(
          'functions',(select md5(string_agg(pg_get_functiondef(p.oid)||coalesce(p.proacl::text,''),'' order by p.proname))
            from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'),
          'triggers',(select md5(string_agg(pg_get_triggerdef(t.oid),'' order by c.relname,t.tgname))
            from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and not t.tgisinternal),
          'policies',(select md5(string_agg(to_jsonb(p)::text,'' order by tablename,policyname))
            from pg_policies p where schemaname='public'),
          'constraints',(select md5(string_agg(pg_get_constraintdef(c.oid),'' order by t.relname,c.conname))
            from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
            where n.nspname='public'))::text;`);
        console.log(`DEPLOYED_BASELINE_FINGERPRINT ${fingerprint.out.trim()}`);
      }
    }
    await exec(`insert into auth.users values(${quote(owner)});
      insert into public.profiles(id,participant_code) values(${quote(owner)},'P99001');`);
    console.log((await exec("select version();")).out.trim());

    for (const same of [true, false]) await t.test(`independent begin: ${same ? "same" : "different"} request IDs`, async () => {
      const f = await fixture(); const request = randomUUID();
      const a = await hold(beginSQL(f.session, request), `begin_a_${same}`);
      const b = run(`begin; ${auth()} ${beginSQL(f.session, same ? request : randomUUID())} commit;`, `begin_b_${same}`);
      const evidence = await blocked([`begin_b_${same}`]);
      const ar = await a.pending; const br = await b;
      assert.equal(ar.ok, true, ar.err); assert.equal(br.ok, true, br.err);
      const results = [...records(ar), ...records(br)];
      assert.equal(results.filter((row) => row.acquired).length, 1);
      assert.equal(new Set(results.map((row) => row.attempt_id)).size, 1);
      assert.ok(evidence[0].blockers[0] !== evidence[0].pid);
      const counts = records(await exec(`select json_build_object('running',
        (select count(*) from public.question_generation_attempts where session_id=${quote(f.session)} and status='running'),
        'questions',(select count(*) from public.questions where session_id=${quote(f.session)}),
        'candidates',(select count(*) from public.question_candidates where session_id=${quote(f.session)}))::text;`))[0];
      assert.deepEqual(counts, { running: 1, questions: 0, candidates: 0 });
    });

    await t.test("uncommitted begin races seven input writes; failure restores save/claim/image operations", async () => {
      const f = await fixture(); const request = randomUUID();
      const a = await hold(beginSQL(f.session, request), "input_a");
      const mutations = [
        ["context", `update public.sessions set additional_context='changed' where id=${quote(f.session)};`],
        ["selection", `update public.session_contexts set context_id='design_concept' where session_id=${quote(f.session)};`],
        ["count", `update public.sessions set requested_question_count=1 where id=${quote(f.session)};`],
        ["add", `${auth()} select * from public.reserve_image_upload(${quote(f.session)},${quote(randomUUID())},'png',${quote("b".repeat(64))});`],
        ["register", `insert into public.session_images(session_id,storage_path,original_filename,mime_type,file_size,sort_order)
          values(${quote(f.session)},${quote(`${owner}/${f.session}/${randomUUID()}.png`)},'TEST.png','image/png',100,7);`],
        ["delete", `delete from public.session_images where id=${quote(f.images[0].id)};`],
        ["reorder", `update public.session_images set sort_order=8 where id=${quote(f.images[1].id)};`],
      ];
      const pending = mutations.map(([name, sql]) => run(`begin; ${sql} commit;`, `input_${name}`));
      await blocked(mutations.map(([name]) => `input_${name}`));
      const ar = await a.pending; assert.equal(ar.ok, true, ar.err);
      const attempt = records(ar)[0].attempt_id;
      const outcomes = await Promise.all(pending);
      for (let i = 0; i < outcomes.length; i++) {
        assert.equal(outcomes[i].ok, false, mutations[i][0]);
        assert.match(outcomes[i].err, /Question generation input is locked/, mutations[i][0]);
      }
      for (const sql of [
        `update storage.objects set metadata='{}' where name=${quote(f.images[0].storage_path)};`,
        `delete from storage.objects where name=${quote(f.images[0].storage_path)};`,
        `${auth()} select * from public.begin_image_deletion(${quote(f.session)},${quote(f.images[0].id)});`,
        `${auth()} select public.save_session_context(${quote(f.session)},'ux_ui','web_design',null,'idea_concept',
          'TEST saved context',array['visual_form']);`,
      ]) assert.equal((await run(sql)).ok, false);
      await exec(`${auth("service_role")} ${failSQL(attempt, request)}`);
      await exec(`${auth()} select public.save_session_context(${quote(f.session)},'ux_ui','web_design',null,
        'review_improvement','TEST after failure',array['design_concept']);
        update public.sessions set requested_question_count=1 where id=${quote(f.session)};
        update public.session_images set sort_order=8 where id=${quote(f.images[1].id)};`);
      await f.upload();
      await exec(`${auth()} select * from public.begin_image_deletion(${quote(f.session)},${quote(f.images[0].id)});
        delete from storage.objects where name=${quote(f.images[0].storage_path)};
        select public.finish_image_deletion(${quote(f.session)},${quote(f.images[0].id)});
        select public.claim_context_draft(${quote(f.session)},false,'ux_ui','web_design',null,'review_improvement',array['design_concept']);
        select public.claim_context_draft(${quote(f.session)},true,'ux_ui','web_design',null,'review_improvement',array['design_concept']);`);
      const values = records(await exec(`select json_build_object('count',requested_question_count,
        'context',additional_context,'images',(select count(*) from public.session_images where session_id=s.id),
        'marker',context_draft_auto_claimed_at is not null)::text from public.sessions s where id=${quote(f.session)};`))[0];
      assert.deepEqual(values, { count: 1, context: "TEST after failure", images: 2, marker: true });
    });

    for (const n of [1, 3, 5]) await t.test(`independent concurrent commit/recovery N=${n}`, async () => {
      const f = await fixture(); const request = randomUUID();
      await exec(`${auth()} update public.sessions set requested_question_count=${n} where id=${quote(f.session)};`);
      const attempt = records(await exec(`${auth()} ${beginSQL(f.session, request)}`))[0].attempt_id;
      await exec(`${auth("service_role")} select public.stage_question_generation_candidates(${quote(attempt)},${quote(request)},
        ${quote(JSON.stringify(payload()))}::jsonb,'TEST-MOCK-MODEL','question-generation-v2.5',
        'why_box_question_generation_v2_0','v1.0','2026-10-08T00:00:00Z');`);
      const commit = `select public.commit_question_generation(${quote(attempt)},${quote(request)})::text;`;
      const a = await hold(commit, `commit_a_${n}`, "service_role");
      const b = run(`begin; ${auth("service_role")} ${commit} commit;`, `commit_b_${n}`);
      await blocked([`commit_b_${n}`]);
      const ar = await a.pending; const br = await b;
      assert.equal(ar.ok, true, ar.err); assert.equal(br.ok, true, br.err);
      assert.equal([...records(ar), ...records(br)].filter((row) => row.saved).length, 1);
      const counts = records(await exec(`select json_build_object(
        'candidates',(select count(*) from public.question_candidates where session_id=s.id),
        'questions',(select count(*) from public.questions where session_id=s.id),
        'targets',(select count(*) from public.question_targets where session_id=s.id),
        'distinct_targets',(select count(distinct (question_id,image_id)) from public.question_targets where session_id=s.id),
        'state',status,'attempt',(select status from public.question_generation_attempts where id=${quote(attempt)}))::text
        from public.sessions s where id=${quote(f.session)};`))[0];
      assert.deepEqual(counts, { candidates: 5, questions: n, targets: n === 1 ? 1 : n + 1,
        distinct_targets: n === 1 ? 1 : n + 1, state: "in_progress", attempt: "completed" });
      assert.equal(records(await exec(`${auth("service_role")} ${commit}`))[0].saved, false);
      assert.equal(records(await exec(`${auth()} ${beginSQL(f.session, request)}`))[0].acquired, false);
      const stored = records(await exec(`${auth()} select json_build_object('question',q.question_text,'rank',c.candidate_rank)::text
        from public.questions q join public.question_candidates c on c.id=q.source_candidate_id
        where q.session_id=${quote(f.session)} order by q.slot_index;`));
      assert.equal(stored.length, n);
    });
  } finally {
    if (created) {
      await exec(`drop database ${database};`, "cleanup", "postgres");
      // These roles were created solely by this fixture in the approved disposable cluster.
      await exec("drop role anon,authenticated,service_role;", "cleanup", "postgres");
    }
  }
});
