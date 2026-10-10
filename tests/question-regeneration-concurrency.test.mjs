import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import {
  initialize, populate, owner, quote, auth, beginSQL, dispatchSQL, stageSQL, commitSQL,
  failSQL, recoverSQL, answerSQL, completeSQL, pinsSQL, targetsSQL, expireSQL,
} from "./question-regeneration-fixture.mjs";

// No ambient PG/DATABASE/Supabase credentials, external hosts, or preexisting cluster are used.
const bin = "/opt/homebrew/opt/postgresql@17/bin";
const environment = { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C" };
function processRun(command, args, input, env = environment) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; let err = "";
    child.stdout.on("data", (data) => { out += data; });
    child.stderr.on("data", (data) => { err += data; });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ ok: code === 0, out, err }));
    child.stdin.end(input);
  });
}
async function freePort() {
  const server = createServer();
  await new Promise((resolveListening, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListening); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
const parsed = (r) => r.out.split("\n").filter((line) => /^(?:\{|\[|"|t$|f$|true$|false$|null$|\d+$)/.test(line))
  .map((line) => line === "t" ? true : line === "f" ? false : JSON.parse(line));

test("fresh disposable loopback PostgreSQL 17: independent regeneration races and failure atomicity", async (t) => {
  const cluster = resolve(`.qrpg-${process.pid}-${randomUUID().slice(0, 8)}`);
  const port = await freePort();
  let started = false;
  async function run(sql, name = "observer") {
    return processRun(`${bin}/psql`, ["-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1",
      "-p", String(port), "-U", "postgres", "-d", "postgres"],
    `set statement_timeout='15s';set lock_timeout='10s';\n${sql}`,
    { ...environment, PGAPPNAME: name, PGCONNECT_TIMEOUT: "5" });
  }
  async function exec(sql, name) {
    const result = await run(sql, name);
    assert.equal(result.ok, true, result.err);
    return result;
  }
  const json = async (sql) => parsed(await exec(sql)).at(-1);
  const fixture = () => populate(exec, json);
  async function waitFor(sql, predicate, label) {
    for (let i = 0; i < 80; i++) {
      const result = await json(sql);
      if (predicate(result)) return result;
      await delay(25);
    }
    assert.fail(`Missing native lock evidence: ${label}`);
  }
  async function hold(sql, name) {
    const pending = run(`begin;${sql}select pg_sleep(2);commit;`, name);
    await waitFor(`select jsonb_build_object('pid',pid,'wait',wait_event) as result from pg_stat_activity
      where application_name=${quote(name)};`, (r) => r?.wait === "PgSleep", name);
    return { pending };
  }
  async function blocked(names) {
    const evidence = await waitFor(`select jsonb_agg(jsonb_build_object('name',application_name,
      'pid',pid,'blockers',pg_blocking_pids(pid))) as result from pg_stat_activity
      where application_name in (${names.map(quote).join(",")});`,
    (rows) => rows?.length === names.length && rows.every((row) => row.blockers.length), names.join(","));
    assert.equal(new Set(evidence.map((r) => r.pid)).size, names.length);
    console.log(`REGENERATION_NATIVE_LOCK_EVIDENCE ${JSON.stringify(evidence)}`);
  }
  const expectFailure = async (pending, pattern) => {
    const result = await pending;
    assert.equal(result.ok, false, result.out);
    assert.match(result.err, pattern);
  };
  async function processed(f) {
    await exec(answerSQL(f.questions[1]));
    for (const q of f.questions.filter((_, i) => i !== 1))
      await exec(`${auth()}select public.apply_question_action(${quote(f.session)},${quote(q.id)},
        ${quote(randomUUID())},'skip',${quote(owner)},null);`);
  }
  try {
    const version = await processRun(`${bin}/initdb`, ["--version"]);
    assert.equal(version.ok, true, version.err);
    assert.match(version.out, /PostgreSQL\) 17\./);
    await mkdir(cluster);
    const init = await processRun(`${bin}/initdb`, ["-D", cluster, "-U", "postgres", "-A", "trust",
      "-E", "UTF8", "--locale=C", "--no-instructions"]);
    assert.equal(init.ok, true, init.err);
    const start = await processRun(`${bin}/pg_ctl`, ["-D", cluster, "-l", `${cluster}/server.log`, "-w",
      "start", "-o", `-h 127.0.0.1 -p ${port} -k ${cluster} -c fsync=off`]);
    assert.equal(start.ok, true, start.err + readFileSync(`${cluster}/server.log`, "utf8")); started = true;
    assert.equal(await json("select to_jsonb(count(*)) as result from pg_roles where rolname in ('anon','authenticated','service_role');"), 0);
    assert.match((await exec("select version();")).out, /PostgreSQL 17\./);
    await initialize(exec);

    await t.test("same request admission replay and different session-inflight ID serialized", async () => {
      const f = await fixture(); const id = randomUUID();
      const { pending: a } = await hold(beginSQL(f, f.questions[0], id), "admit_a");
      const b = run(beginSQL(f, f.questions[0], id), "admit_same");
      const c = run(beginSQL(f, f.questions[1]), "admit_other");
      await blocked(["admit_same", "admit_other"]);
      const first = parsed(await a).at(-1);
      const replay = await b;
      assert.equal(replay.ok, true, replay.err);
      assert.equal(first.acquired, true);
      assert.equal(parsed(replay).at(-1).acquired, false);
      assert.equal(parsed(replay).at(-1).attempt_id, first.attempt_id);
      await expectFailure(c, /pending/);
      await exec(failSQL(first, "QR-RECOVERY"));
    });

    await t.test("dispatch CAS is one durable consumption across three independently connected contenders", async () => {
      const f = await fixture(); const r = await json(beginSQL(f));
      const { pending: a } = await hold(dispatchSQL(r), "dispatch_a");
      const b = run(dispatchSQL(r), "dispatch_b");
      const c = run(dispatchSQL(r), "dispatch_c");
      await blocked(["dispatch_b", "dispatch_c"]);
      assert.equal(parsed(await a).at(-1), true);
      assert.equal(parsed(await b).at(-1), false);
      assert.equal(parsed(await c).at(-1), false);
      assert.equal(await json(`select to_jsonb(count(*)) from public.question_regeneration_attempts
        where session_id=${quote(f.session)} and dispatched_at is not null;`), 1);
      await exec(failSQL(r, "QR-TIMEOUT"));
      assert.equal(await json(dispatchSQL(r)), false);
    });

    await t.test("answer-first rejects stale admission; admission-first blocks answer and legacy action", async () => {
      const f = await fixture();
      const { pending: a } = await hold(answerSQL(f.questions[0]), "answer_first");
      const b = run(beginSQL(f), "admission_after_answer");
      await blocked(["admission_after_answer"]);
      assert.equal((await a).ok, true);
      await expectFailure(b, /Answer revision changed/);
      const g = await fixture();
      const { pending: c } = await hold(beginSQL(g), "admission_first");
      const d = run(answerSQL(g.questions[0]), "answer_after_admission");
      const e = run(`${auth()}select public.apply_question_action(${quote(g.session)},${quote(g.questions[0].id)},
        ${quote(randomUUID())},'skip',${quote(owner)},null);`, "skip_after_admission");
      await blocked(["answer_after_admission", "skip_after_admission"]);
      const r = parsed(await c).at(-1);
      await expectFailure(d, /pending/); await expectFailure(e, /pending/);
      await exec(failSQL(r, "QR-RECOVERY"));
      await exec(answerSQL(g.questions[0]));
    });

    await t.test("completed wins admission and staged commit races; old questions/pins stay intact", async () => {
      for (const staged of [false, true]) {
        const f = await fixture(); await processed(f);
        let r;
        if (staged) { r = await json(beginSQL(f)); await exec(dispatchSQL(r)); await exec(stageSQL(r)); }
        const before = await json(pinsSQL(f)); const pins = await json(targetsSQL(f));
        const { pending: a } = await hold(completeSQL(f), `complete_first_${staged}`);
        const b = run(staged ? commitSQL(r) : beginSQL(f), `after_complete_${staged}`);
        await blocked([`after_complete_${staged}`]);
        assert.equal((await a).ok, true);
        await expectFailure(b, /read-only/);
        assert.deepEqual(await json(pinsSQL(f)), before);
        assert.deepEqual(await json(targetsSQL(f)), pins);
        if (r) await exec(failSQL(r, "QR-STALE"));
      }
    });

    await t.test("commit serializes an existing empty-answer UPDATE and preserves its original question association", async () => {
      const f = await fixture();
      const q = f.questions[0];
      await exec(answerSQL(q, ""));
      const revision = await json(`select to_jsonb(updated_at) from public.answers where question_id=${quote(q.id)};`);
      const r = await json(beginSQL(f, q, randomUUID(), revision));
      await exec(dispatchSQL(r)); await exec(stageSQL(r));
      const { pending: a } = await hold(commitSQL(r), "commit_before_answer_update");
      const b = run(`${auth("authenticated")}update public.answers set original_answer='Concurrent authored text'
        where question_id=${quote(q.id)};`, "existing_answer_update");
      await blocked(["existing_answer_update"]);
      const result = parsed(await a).at(-1);
      assert.equal(result.status, "completed");
      await expectFailure(b, /active, unskipped question/);
      const answer = await json(`select to_jsonb(a) from public.answers a where question_id=${quote(q.id)};`);
      assert.equal(answer.question_id, q.id);
      assert.equal(answer.original_answer, "");
      assert.equal(await json(`select to_jsonb(count(*)) from public.answers where question_id=${quote(result.result_question_id)};`), 0);
    });

    await t.test("commit wins completion race atomically and makes session no longer summary-ready", async () => {
      const f = await fixture(); await processed(f);
      const r = await json(beginSQL(f)); await exec(dispatchSQL(r)); await exec(stageSQL(r));
      const { pending: a } = await hold(commitSQL(r), "commit_first");
      const b = run(`begin;${completeSQL(f)}commit;`, "complete_after_commit");
      await blocked(["complete_after_commit"]);
      assert.equal(parsed(await a).at(-1).status, "completed");
      await expectFailure(b, /not ready/);
      assert.equal(await json(`select to_jsonb(status) from public.sessions where id=${quote(f.session)};`), "in_progress");
      assert.equal((await json(commitSQL(r))).changed, false);
    });

    await t.test("failure preserves old pins; expired reserved versus dispatched unknown recovery", async () => {
      const f = await fixture(); const before = await json(pinsSQL(f)); const pins = await json(targetsSQL(f));
      const reserved = await json(beginSQL(f));
      await exec(expireSQL(reserved));
      assert.equal((await json(recoverSQL(reserved))).status, "failed");
      const r = await json(beginSQL(f)); await exec(dispatchSQL(r)); await exec(stageSQL(r));
      await exec(`create function public.local_native_target_failure() returns trigger language plpgsql as
        $$begin raise exception 'injected native pin failure';end;$$;
        create trigger zz_local_native_target_failure before insert on public.question_targets
        for each row execute function public.local_native_target_failure();`);
      await expectFailure(run(commitSQL(r)), /injected native pin failure/);
      assert.deepEqual(await json(pinsSQL(f)), before);
      assert.deepEqual(await json(targetsSQL(f)), pins);
      await exec("drop trigger zz_local_native_target_failure on public.question_targets; drop function public.local_native_target_failure();");
      await exec(failSQL(r, "QR-VALIDATION"));
      const unknown = await json(beginSQL(f)); await exec(dispatchSQL(unknown));
      await exec(expireSQL(unknown, true));
      assert.equal((await json(recoverSQL(unknown))).status, "dispatch_unknown");
      assert.equal(await json(dispatchSQL(unknown)), false);
      assert.equal(await json(`select to_jsonb(count(*)) from public.question_regeneration_attempts
        where session_id=${quote(f.session)} and dispatched_at is not null;`), 2);
      assert.deepEqual(await json(pinsSQL(f)), before);
      assert.deepEqual(await json(targetsSQL(f)), pins);
    });
    console.log("VERIFIED fresh PostgreSQL 17 loopback cluster; no remote credentials or provider calls");
  } finally {
    if (started) {
      const stopped = await processRun(`${bin}/pg_ctl`, ["-D", cluster, "-m", "immediate", "-w", "stop"]);
      assert.equal(stopped.ok, true, stopped.err);
    }
    await rm(cluster, { recursive: true, force: true });
  }
});
