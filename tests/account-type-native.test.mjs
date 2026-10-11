import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { Buffer } from "node:buffer";
import console from "node:console";
import { URL } from "node:url";
import { setTimeout } from "node:timers";
import ExcelJS from "exceljs";
import { typescriptLoader } from "./helpers/typescript-loader.mjs";
import { initialize, populate, owner, other, auth, quote, answerSQL, beginSQL, stageSQL, commitSQL } from "./question-regeneration-fixture.mjs";

const bin = "/opt/homebrew/opt/postgresql@17/bin";
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("supabase/migrations/20261011193000_account_type_research_policy.sql");
// Only the two operation target constants are replaced, never schema or guard logic.
const synthetic = sql => sql.replaceAll("89507e34-b4fa-464a-b359-316be9a6bdcb", other)
  .replaceAll("ec0bba1e-3720-4200-a5e1-aed0673d2c32", owner);
const operation = synthetic(read("supabase/operations/classify-e2e-p01.sql"));
const approval = "set whybox.production_classification_approved='jaqyzbrvufknpsbcuqzw';";
const rpc = (id, expected, type) => `select public.change_participant_account_type(
  ${quote(id)},${quote(expected)},${quote(type)},'Synthetic classification test');`;

test("isolated native PostgreSQL P/T migration, RLS, concurrency and rename recovery", async t => {
  const directory = mkdtempSync(join(process.cwd(), ".account-type-pg-"));
  // Explicit private Unix socket, no TCP listener or ambient PG connection settings.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C", LANG: "C" };
  const args = ["-X", "-v", "ON_ERROR_STOP=1", "-h", directory, "-U", "postgres", "-d", "postgres", "-At"];
  let started = false;
  const exec = sql => execFileSync(join(bin, "psql"), [...args, "-c", sql],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const json = sql => JSON.parse(exec(sql).split("\n").at(-1));
  const snapshot = table => exec(`select md5(coalesce(
    (select jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text from ${table} r),'[]'));`);
  const fail = (sql, pattern) => assert.throws(() => exec(sql), pattern);
  const asyncExec = sql => {
    const child = spawn(join(bin, "psql"), [...args, "-c", sql], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    return new Promise(resolve => child.on("close", code => resolve({ code, stdout, stderr })));
  };
  try {
    execFileSync(join(bin, "initdb"), ["-D", directory, "-U", "postgres", "-A", "trust", "--no-locale", "--encoding=UTF8"],
      { env, stdio: "pipe" });
    execFileSync(join(bin, "pg_ctl"), ["-D", directory, "-l", join(directory, "server.log"),
      "-o", `-h '' -k ${directory} -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap`, "-w", "start"],
      { env, stdio: "pipe" });
    started = true;
    assert.equal(exec("show listen_addresses"), "");
    await initialize(exec);
    for (const file of ["20261010002000_regeneration_dispatch_provenance.sql",
      "20261010003000_session_completion_briefing.sql"]) {
      exec(read(`supabase/migrations/${file}`));
    }
    exec(`alter table auth.users add column email text unique, add column encrypted_password text,
      add column role text default 'authenticated', add column email_confirmed_at timestamptz,
      add column updated_at timestamptz default now();
      create table auth.identities(id uuid primary key default gen_random_uuid(),
        user_id uuid references auth.users(id), provider text, identity_data jsonb);
      update auth.users set email=case when id=${quote(owner)} then 'p01@participants.whybox.invalid'
        else 'synthetic-admin@example.invalid' end, encrypted_password='NON_SECRET_SYNTHETIC_HASH',
        email_confirmed_at=now();
      insert into auth.identities(user_id,provider,identity_data)
        select id,'email',jsonb_build_object('email',email) from auth.users;
      update public.profiles set participant_code='P01' where id=${quote(owner)};
      update public.profiles set participant_code=null,role='admin' where id=${quote(other)};`);
    const f = await populate(exec, json, 5);
    const regeneration = json(beginSQL(f));
    exec(`${auth()} select public.authorize_question_regeneration_dispatch(
      ${quote(regeneration.attempt_id)},${quote(regeneration.request_id)},${quote(owner)},
      'OFFLINE-MOCK','question-regeneration-v1.0','why_box_question_regeneration_v1_0');`);
    exec(stageSQL(regeneration));
    exec(commitSQL(regeneration));
    const active = json(`select to_jsonb(q) from questions q where session_id=${quote(f.session)}
      and is_active_version and slot_index=1`);
    exec(answerSQL(active, "Synthetic original answer"));
    exec(`${auth()} update public.answers set refined_answer='Synthetic refined answer',
      refinement_used=true,refined_at=now(),current_answer_version='refined'
      where question_id=${quote(active.id)};`);
    const request = randomUUID();
    for (const question of f.questions.slice(1)) {
      exec(`${auth()} select public.apply_question_action(${quote(f.session)},
        ${quote(question.id)},${quote(randomUUID())},'skip',${quote(owner)},null);`);
    }
    exec(`${auth("authenticated")} select public.begin_session_completion(${quote(f.session)},${quote(request)},null);`);
    exec(`${auth()} select public.authorize_session_briefing_dispatch(${quote(f.session)},${quote(request)},${quote(owner)});
      select public.finish_session_briefing(${quote(f.session)},${quote(request)},${quote(owner)},
        'Synthetic briefing','OFFLINE-MOCK','session-design-briefing-v1.0','why_box_session_design_briefing_v1_0');`);
    exec(`${auth("authenticated")} select public.save_session_briefing_version(
      ${quote(f.session)},0,'Synthetic edited briefing');`);
    exec(`insert into public.diaries(session_id,participant_id,status,experience_choices_json,feeling_choices_json,free_text,submitted_at)
      values(${quote(f.session)},${quote(owner)},'submitted','["Synthetic choice 1","Synthetic choice 2"]',
        '["Synthetic feeling"]','Synthetic diary',now());`);
    const p4 = randomUUID(), p5 = randomUUID(), p0 = randomUUID(), unknown = randomUUID();
    exec(`insert into auth.users(id) values(${quote(p4)}),(${quote(p5)}),(${quote(p0)}),(${quote(unknown)});
      insert into profiles(id,participant_code) values
        (${quote(p4)},'P50'),(${quote(p5)},'P51'),(${quote(p0)},'P52'),(${quote(unknown)},'P53');
      insert into sessions(participant_id) values(${quote(unknown)});`);
    // Create completed cohorts through existing RPCs, before direct-upload restrictions.
    for (const [id, count] of [[p4, 4], [p5, 5]]) for (let i = 0; i < count; i++) {
      const mappedExec = sql => exec(sql.replaceAll(owner, id));
      const mappedJson = sql => json(sql.replaceAll(owner, id));
      const cohort = await populate(mappedExec, mappedJson, 1);
      mappedExec(answerSQL(cohort.questions[0], "Synthetic cohort answer"));
      const completion = randomUUID();
      mappedExec(`${auth("authenticated")} select public.begin_session_completion(
        ${quote(cohort.session)},${quote(completion)},null);`);
      mappedExec(`${auth()} select public.authorize_session_briefing_dispatch(
        ${quote(cohort.session)},${quote(completion)},${quote(owner)});
        select public.finish_session_briefing(${quote(cohort.session)},${quote(completion)},${quote(owner)},
          'Synthetic cohort briefing','OFFLINE-MOCK','session-design-briefing-v1.0','why_box_session_design_briefing_v1_0');`);
    }
    exec(read("supabase/migrations/20261010235000_verified_direct_image_upload.sql"));
    const preserved = ["sessions", "session_contexts", "session_images", "questions", "question_targets",
      "answers", "question_events", "diaries", "session_briefing_sources", "session_briefing_versions", "storage.objects"];
    const baselines = new Map(preserved.map(table => [table, snapshot(table)]));
    const authBaseline = snapshot("auth.users");
    const profilesBaseline = snapshot("profiles");
    const policiesBaseline = exec("select md5(jsonb_agg(to_jsonb(p) order by policyname)::text) from pg_policies p;");

    await t.test("preflight executes read-only on the full baseline with synthetic identities", () => {
      const result = exec(synthetic(read("supabase/operations/account-type-preflight.sql")));
      assert.match(result, /t\|t\|t\|t\|t\|t\|t\|t/);
      assert.equal(snapshot("auth.users"), authBaseline);
    });
    await t.test("late migration failure rolls back every added object and existing rows", () => {
      fail(migration.replace(/commit;\s*$/, "select 1/0; commit;"), /division by zero/);
      assert.equal(exec("select to_regclass('public.account_type_events') is null"), "t");
      assert.equal(exec("select count(*) from pg_attribute where attrelid='profiles'::regclass and attname='account_type' and not attisdropped"), "0");
      assert.equal(snapshot("profiles"), profilesBaseline);
    });
    await t.test("migration commits with old profiles NULL, no audit backfill and unchanged data/RLS", () => {
      exec(migration);
      assert.equal(exec("select count(*) from profiles where account_type is not null"), "0");
      assert.equal(exec("select count(*) from account_type_events"), "0");
      assert.equal(snapshot("auth.users"), authBaseline);
      assert.equal(exec("select md5(jsonb_agg(to_jsonb(p) order by policyname)::text) from pg_policies p where tablename<>'account_type_events'"), policiesBaseline);
      for (const [table, value] of baselines) assert.equal(snapshot(table), value, table);
      exec(synthetic(read("supabase/operations/account-type-postflight.sql")));
      fail(migration, /already exists/);
    });
    await t.test("P/T/NULL creation, T code constraint and audit INSERT trigger work", () => {
      const ids = [randomUUID(), randomUUID()];
      const count = exec(`begin;
        insert into auth.users(id) values(${quote(ids[0])}),(${quote(ids[1])});
        set role service_role;
        insert into profiles(id,participant_code,account_type)
          values (${quote(ids[0])},'T20','T'),(${quote(ids[1])},'P20','P');
        reset role;
        select count(*) from account_type_events where changed_by is null; rollback;`).split("\n").at(-2);
      assert.equal(count, "2");
      assert.equal(exec("select count(*) from account_type_events"), "0");
      fail(`update profiles set account_type='X' where id=${quote(owner)}`, /profiles_account_type_check/);
      fail(`update profiles set account_type='P' where id=${quote(other)}`, /profiles_account_type_check/);
    });
    await t.test("admin RPC succeeds atomically, participant/anon/direct writes and admin target are denied", () => {
      fail(`${auth("authenticated", owner)} ${rpc(owner, null, "T")}`, /ACCOUNT-TYPE-DENIED/);
      fail(`set role anon; ${rpc(owner, null, "T")}`, /permission denied/);
      fail(`${auth("authenticated", other)} update profiles set account_type='T' where id=${quote(owner)}`, /permission denied/);
      fail(`${auth("authenticated", other)} ${rpc(other, null, "T")}`, /ACCOUNT-TYPE-TARGET/);
      assert.equal(exec(`begin; ${auth("authenticated", other)} ${rpc(owner, null, "P")}
        select count(*) from account_type_events where changed_by=${quote(other)}; rollback;`).split("\n").at(-2), "1");
      assert.equal(snapshot("auth.users"), authBaseline);
    });
    await t.test("audit RLS, immutable history, invalid input, stale CAS and NULL clear are enforced", () => {
      exec(`begin; ${auth("authenticated", other)} ${rpc(owner, null, "P")} rollback;`);
      const classified = randomUUID();
      exec(`insert into auth.users(id) values(${quote(classified)});
        insert into profiles(id,participant_code,account_type) values(${quote(classified)},'P30','P');`);
      assert.equal(exec(`${auth("authenticated", owner)} select count(*) from account_type_events;`).split("\n").at(-1), "0");
      assert.equal(exec(`${auth("authenticated", other)} select count(*) from account_type_events;`).split("\n").at(-1), "1");
      fail(`update account_type_events set reason='changed'`, /immutable/);
      fail(`delete from account_type_events`, /immutable/);
      fail(`truncate account_type_events`, /immutable/);
      fail(`update profiles set account_type=null where id=${quote(classified)}`, /ACCOUNT-TYPE-CLEAR/);
      fail(`${auth("authenticated", other)} ${rpc(classified, null, "T")}`, /ACCOUNT-TYPE-CONFLICT/);
      fail(`${auth("authenticated", other)} ${rpc(classified, "P", "X")}`, /ACCOUNT-TYPE-INPUT/);
      assert.equal(exec(`${auth("authenticated", other)} ${rpc(classified, "P", "P")}`).split("\n").at(-1), "f");
    });
    await t.test("two independent connections serialize changes and reject the stale contender", async () => {
      const id = randomUUID();
      exec(`insert into auth.users(id) values(${quote(id)});
        insert into profiles(id,participant_code) values(${quote(id)},'P40');`);
      const first = asyncExec(`set application_name='pt-holder'; begin; ${auth("authenticated", other)}
        ${rpc(id, null, "P")} select pg_sleep(2); commit;`);
      let sleeping = false;
      for (let i = 0; i < 60; i++) {
        if (exec("select exists(select 1 from pg_stat_activity where application_name='pt-holder' and wait_event='PgSleep')") === "t") {
          sleeping = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!sleeping) { await first; assert.fail("Concurrent holder did not reach its locked state"); }
      const second = asyncExec(`${auth("authenticated", other)} ${rpc(id, null, "T")}`);
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.code, 0, a.stderr);
      assert.notEqual(b.code, 0); assert.match(b.stderr, /ACCOUNT-TYPE-CONFLICT/);
      assert.equal(exec(`select count(*) from account_type_events where participant_id=${quote(id)}`), "1");
    });

    const mockAuth = {
      async updateUserById(id, attributes) {
        assert.equal(id, owner);
        assert.deepEqual(Object.keys(attributes).sort(), ["email", "email_confirm"]);
        assert.equal(attributes.email_confirm, true);
        exec(`update auth.users set email=${quote(attributes.email)},email_confirmed_at=now(),updated_at=now()
          where id=${quote(id)};
          update auth.identities set identity_data=jsonb_build_object('email',${quote(attributes.email)})
          where user_id=${quote(id)} and provider='email';`);
        return { data: { user: { id } }, error: null };
      },
    };
    await t.test("rename requires approval and a confirmed prior Auth email change", () => {
      fail(operation, /approval and project confirmation/);
      fail(approval + operation, /Auth Admin email transition/);
    });
    await mockAuth.updateUserById(owner, { email: "t01@participants.whybox.invalid", email_confirm: true });
    await t.test("T01 profile, Auth email and identity collisions independently stop conversion", () => {
      const id = randomUUID();
      for (const collision of [
        `insert into auth.users(id) values(${quote(id)});
          insert into profiles(id,participant_code) values(${quote(id)},'T01');`,
        `insert into auth.users(id,email) values(${quote(id)},'t01@participants.whybox.invalid');`,
        `insert into auth.users(id) values(${quote(id)}); insert into auth.identities(user_id,provider,identity_data)
          values(${quote(id)},'email','{"email":"t01@participants.whybox.invalid"}');`,
      ]) {
        fail(approval + operation.replace("do $$", `${collision}\ndo $$`), /already exists|duplicate key/);
        assert.equal(exec(`select participant_code from profiles where id=${quote(owner)}`), "P01");
      }
    });
    await t.test("profile failure/ROLLBACK does not undo Auth, but Mock Admin email compensation restores login identity", async () => {
      exec(approval + operation);
      assert.equal(exec(`select participant_code from profiles where id=${quote(owner)}`), "P01");
      assert.equal(exec(`select email='t01@participants.whybox.invalid' from auth.users where id=${quote(owner)}`), "t");
      fail(approval + operation.replace("get diagnostics affected", "perform 1/0;\n get diagnostics affected"), /division by zero/);
      await mockAuth.updateUserById(owner, { email: "p01@participants.whybox.invalid", email_confirm: true });
      assert.equal(exec(`select email='p01@participants.whybox.invalid' and encrypted_password='NON_SECRET_SYNTHETIC_HASH'
        from auth.users where id=${quote(owner)}`), "t");
      assert.equal(exec(`select count(*) from account_type_events where participant_id=${quote(owner)}`), "0");
    });
    await t.test("successful T01 conversion keeps UUID, password, admin and every app/Storage record", async () => {
      const adminBefore = json(`select to_jsonb(u) from auth.users u where id=${quote(other)}`);
      await mockAuth.updateUserById(owner, { email: "t01@participants.whybox.invalid", email_confirm: true });
      exec(approval + operation.replace(/rollback;\s*$/, "commit;"));
      assert.equal(exec(`select participant_code||':'||account_type from profiles where id=${quote(owner)}`), "T01:T");
      assert.equal(exec(`select encrypted_password='NON_SECRET_SYNTHETIC_HASH' from auth.users where id=${quote(owner)}`), "t");
      assert.deepEqual(json(`select to_jsonb(u) from auth.users u where id=${quote(other)}`), adminBefore);
      for (const [table, value] of baselines) assert.equal(snapshot(table), value, table);
      assert.equal(exec(`${auth("authenticated", owner)} select public.owns_session(${quote(f.session)})`).split("\n").at(-1), "t");
      assert.equal(exec(`${auth("authenticated", other)} select count(*) from sessions where id=${quote(f.session)}`).split("\n").at(-1), "1");
      fail(approval + operation, /identity differs/);
    });
    await t.test("postflight executes read-only after conversion and validates grants/triggers", () => {
      const before = snapshot("profiles");
      const result = exec(synthetic(read("supabase/operations/account-type-postflight.sql")));
      assert.match(result, /t\|t\|t\|t/);
      assert.equal(exec("select relrowsecurity from pg_class where oid='account_type_events'::regclass"), "t");
      assert.equal(exec("select has_function_privilege('service_role','change_participant_account_type(uuid,text,text,text)','EXECUTE')"), "f");
      assert.equal(exec("select has_function_privilege('authenticated','record_account_type_event()','EXECUTE')"), "f");
      assert.equal(exec("select has_table_privilege('authenticated','account_type_events','INSERT,UPDATE,DELETE,TRUNCATE')"), "f");
      assert.equal(snapshot("profiles"), before);
    });
    await t.test("native DB feeds actual dashboard and XLSX code: P-only cohort, five-use rate and T exclusion", async () => {
      exec(`update profiles set account_type='P' where id in (${quote(p4)},${quote(p5)},${quote(p0)});`);
      const safe = name => {
        assert.match(name, /^[a-z_]+$/);
        return `"${name}"`;
      };
      // A read-only Supabase-shaped adapter over real PostgreSQL SELECTs.
      const client = {
        async rpc(name, {p_page,p_filter}) {
          assert.ok(["admin_dashboard_read","admin_participants_read"].includes(name));
          return {data:json(`${auth("authenticated",other)}
            select public.${name}(${p_page},${quote(p_filter)})`),error:null};
        },
        from(table) {
        let columns = "*", conditions = [], order = "id", offset = 0, limit = 500, head = false;
        const query = {
          select(value, options = {}) { columns = value; head = options.head === true; return this; },
          order(value) { order = value; return this; },
          range(a, b) { offset = a; limit = b - a + 1; return this; },
          in(column, values) { conditions.push(`${safe(column)} in (${values.map(quote).join(",")})`); return this; },
          eq(column, value) { conditions.push(`${safe(column)}=${quote(value)}`); return this; },
          then(resolve, reject) {
            try {
              const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
              const rows = head ? null : json(`${auth("authenticated",other)} select coalesce(jsonb_agg(to_jsonb(r)),'[]') from
                (select ${columns.split(",").map(safe).join(",")} from ${safe(table)} ${where}
                  order by ${safe(order)} offset ${offset} limit ${limit}) r`);
              const count = head ? Number(exec(`select count(*) from ${safe(table)} ${where}`)) : null;
              return Promise.resolve({ data: rows, count, error: null }).then(resolve, reject);
            } catch (error) { return Promise.reject(error).then(resolve, reject); }
          },
        };
        return query;
      } };
      const readMigration=read("supabase/migrations/20261011220000_admin_read_performance.sql");
      fail(readMigration.replace(/commit;\s*$/,"select 1/0; commit;"),/division by zero/);
      assert.equal(exec("select to_regprocedure('public.admin_dashboard_read(integer,text)') is null"),"t");
      const readPolicyBaseline=exec("select md5(jsonb_agg(to_jsonb(p) order by policyname)::text) from pg_policies p");
      exec(readMigration);
      assert.equal(exec("select md5(jsonb_agg(to_jsonb(p) order by policyname)::text) from pg_policies p"),readPolicyBaseline);
      for(const name of ["admin_dashboard_read","admin_participants_read"]) {
        const signature=`public.${name}(integer,text)`;
        const definition=json(`select jsonb_build_object('definer',prosecdef,'volatility',provolatile,'config',proconfig)
          from pg_proc where oid=${quote(signature)}::regprocedure`);
        assert.equal(definition.definer,false);assert.equal(definition.volatility,"s");
        assert.deepEqual(definition.config,['search_path=""']);
        for(const role of ["anon","service_role"]) {
          assert.equal(exec(`select has_function_privilege(${quote(role)},${quote(signature)},'EXECUTE')`),"f");
          fail(`${auth(role,other)} select public.${name}()`,/permission denied/);
        }
        assert.equal(exec(`select has_function_privilege('authenticated',${quote(signature)},'EXECUTE')`),"t");
        fail(`${auth("authenticated",owner)} select public.${name}()`,/ADMIN-READ-DENIED/);
        fail(`begin; update profiles set status='deactivated' where id=${quote(other)};
          ${auth("authenticated",other)} select public.${name}(); rollback;`,/ADMIN-READ-DENIED/);
        // Even an accidental future service-role grant cannot bypass the explicit identity guard.
        fail(`begin; grant execute on function ${signature} to service_role;
          ${auth("service_role",owner)} select public.${name}(); rollback;`,/ADMIN-READ-DENIED/);
        for(const args of ["0,'P'","-1,'P'","null,'P'","1,null","1,'X'"]) {
          fail(`${auth("authenticated",other)} select public.${name}(${args})`,/ADMIN-READ-INPUT/);
        }
      }
      const load = typescriptLoader({ exceljs: { default: ExcelJS } });
      const dashboard = await load("src/lib/admin/dashboard.ts").readAdminDashboard(client, 1);
      // Two earlier guard/concurrency fixtures are also P, each with zero sessions.
      assert.deepEqual(dashboard.research, { participants: 5, sessions: 9, completed: 9,
        diaries: 0, achieved: 1, achievementRate: 20 });
      assert.deepEqual(dashboard.service, { sessions: 10, p: 9, t: 1, unclassified: 1 });
      assert.ok(dashboard.rows.every(row => row.account_type === "P"));
      const tDashboard = await load("src/lib/admin/dashboard.ts").readAdminDashboard(client, 1, "T");
      assert.equal(tDashboard.rows[0].id, f.session);
      assert.equal(tDashboard.rows[0].participant_code, "T01");
      assert.equal(tDashboard.rows[0].questions,5);
      assert.equal(tDashboard.rows[0].answered,1);
      assert.equal(tDashboard.rows[0].skipped,4);
      const participantResult=await load("src/lib/admin/participants.ts").readAdminParticipants(client,1,"T");
      assert.equal(participantResult.rows[0].completed,1);assert.equal(participantResult.rows[0].diaries,1);
      assert.equal(participantResult.rows[0].participant_code,"T01");
      const adminRead=(name,page=1,filter="all")=>json(`${auth("authenticated",other)}
        select public.${name}(${page},${quote(filter)})`);
      // Reference query uses correlated scalar lookups, independently of the RPC's CTE aggregates.
      const referenceRows=filter=>json(`${auth("authenticated",other)}
        select coalesce(jsonb_agg(to_jsonb(r) order by r.last_activity_at desc,r.id),'[]') from (
          select s.id,s.participant_id,s.created_at,s.updated_at,s.status,s.requested_question_count,
            p.participant_code,p.account_type,true as is_participant,
            greatest(s.updated_at,
              (select max(greatest(q.created_at,q.answered_at,q.skipped_at)) from questions q where q.session_id=s.id),
              (select max(a.updated_at) from answers a where a.question_id in (select id from questions where session_id=s.id)),
              (select max(updated_at) from diaries where session_id=s.id),
              (select max(edited_at) from session_briefing_versions where session_id=s.id),
              (select max(created_at) from session_images where session_id=s.id)) as last_activity_at,
            (select count(*) from questions where session_id=s.id and is_active_version) as questions,
            (select count(*) from questions where session_id=s.id and is_active_version and status='answered') as answered,
            (select count(*) from questions where session_id=s.id and is_active_version and status='skipped') as skipped
          from sessions s join profiles p on p.id=s.participant_id where p.role='participant'
            and (${quote(filter)}='all' or (${quote(filter)}='unclassified' and p.account_type is null)
              or p.account_type=${quote(filter)})
        ) r`);
      for(const filter of ["P","T","all","unclassified"]) {
        assert.deepEqual(adminRead("admin_dashboard_read",1,filter).rows,referenceRows(filter));
      }
      const sources=[
        ["sessions","updated_at",`id=${quote(f.session)}`],
        ["questions","created_at",`session_id=${quote(f.session)} and not is_active_version`],
        ["questions","answered_at",`session_id=${quote(f.session)} and not is_active_version`],
        ["questions","skipped_at",`session_id=${quote(f.session)} and not is_active_version`],
        ["answers","updated_at",`question_id=${quote(active.id)}`],
        ["diaries","updated_at",`session_id=${quote(f.session)}`],
        ["session_briefing_versions","edited_at",`session_id=${quote(f.session)}`],
        ["session_images","created_at",`session_id=${quote(f.session)}`],
      ];
      const transactionJson=sql=>JSON.parse(exec(sql).split("\n").findLast(line=>line.startsWith("{")));
      for(const [table,column,where] of sources) {
        const status=table==="questions"&&column==="answered_at"?", status='answered', skipped_at=null":
          table==="questions"&&column==="skipped_at"?", status='skipped', answered_at=null":"";
        const setup=`begin; alter table ${table} disable trigger user;
          update ${table} set ${column}='2099-01-01T00:00:00Z'${status} where ${where};
          alter table ${table} enable trigger user;`;
        const result=transactionJson(`${setup} ${auth("authenticated",other)}
          select public.admin_dashboard_read(1,'all'); rollback;`);
        assert.equal(result.rows[0].id,f.session,`${table}.${column}`);
        assert.equal(Date.parse(result.rows[0].last_activity_at),Date.parse("2099-01-01T00:00:00Z"),`${table}.${column}`);
      }
      // Empty selection keeps a real page envelope, rather than losing metadata with an empty rowset.
      for(const name of ["admin_dashboard_read","admin_participants_read"]) {
        const empty=transactionJson(`begin; alter table profiles disable trigger user;
          update profiles set account_type='T' where role='participant';
          ${auth("authenticated",other)} select public.${name}(2147483647,'P'); rollback;`);
        assert.deepEqual(empty.rows,[]);assert.equal(empty.page,1);assert.equal(empty.pages,1);
      }
      // Offline before/after benchmark: real SQL and payloads on this private Unix socket.
      // A single psql connection avoids presenting process startup time as database latency.
      const benchmarkIds=Array.from({length:80},(_,i)=>`20000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`);
      const benchmarkProfilesBefore=snapshot("profiles");
      const existingIds=json("select jsonb_agg(id) from profiles where role='participant'");
      const baselineColumns={
        sessions:"id,participant_id,created_at,updated_at,status,requested_question_count",
        profiles:"id,participant_code,role,account_type",
        questions:"id,session_id,status,is_active_version,created_at,answered_at,skipped_at",
        answers:"id,question_id,updated_at",diaries:"id,session_id,participant_id,status,updated_at",
        session_briefing_versions:"id,session_id,edited_at",session_images:"id,session_id,created_at",
      };
      const dashboardBefore=[];
      for(const [table,columns] of Object.entries(baselineColumns)) {
        const total=Number(exec(`select count(*) from ${table}`))+(table==="sessions"?4000:table==="profiles"?80:0);
        for(let offset=0;offset<=total;offset+=500) {
          dashboardBefore.push(`select coalesce(jsonb_agg(to_jsonb(r)),'[]') from
            (select ${columns} from ${table} order by id limit 500 offset ${offset}) r;`);
        }
      }
      const participantsBefore=[`select coalesce(jsonb_agg(to_jsonb(r)),'[]') from
        (select id,participant_code,account_type,status,created_at,last_activity_at from profiles
          where role='participant' order by participant_code) r;`];
      for(const id of [...existingIds,...benchmarkIds]) {
        participantsBefore.push(`select count(*) from sessions where participant_id=${quote(id)} and status='completed';`,
          `select count(*) from diaries where participant_id=${quote(id)} and status='submitted';`);
      }
      const benchmarkScript=`begin;
        insert into auth.users(id) values ${benchmarkIds.map(id=>`(${quote(id)})`).join(",")};
        insert into profiles(id,participant_code,account_type)
          select id,'P'||(row_number() over(order by id)+1000)::text,'P' from auth.users
          where id in (${benchmarkIds.map(quote).join(",")});
        insert into sessions(id,participant_id,created_at,updated_at)
          select md5('admin-benchmark-'||n)::uuid,
            ('20000000-0000-4000-8000-'||lpad(((n-1)%80+1)::text,12,'0'))::uuid,
            '2098-01-01T00:00:00Z','2098-01-01T00:00:00Z' from generate_series(1,4000) n;
        analyze sessions; analyze profiles;
        ${auth("authenticated",other)}
        \\timing on
        \\echo DASHBOARD_BEFORE
        ${dashboardBefore.join("\n")}
        \\echo DASHBOARD_AFTER
        select public.admin_dashboard_read(1,'P');
        \\echo PARTICIPANTS_BEFORE
        ${participantsBefore.join("\n")}
        \\echo PARTICIPANTS_AFTER
        select public.admin_participants_read(1,'all');
        \\echo PAGINATION_CHECK
        select public.admin_dashboard_read(2147483647,'P');
        select public.admin_participants_read(2147483647,'all');
        \\timing off
        rollback;`;
      const benchmarkOutput=execFileSync(join(bin,"psql"),[...args,"-f","-"],{
        env,input:benchmarkScript,encoding:"utf8",stdio:["pipe","pipe","pipe"],
      });
      const sections={};let section=null;
      for(const line of benchmarkOutput.split("\n")) {
        if(["DASHBOARD_BEFORE","DASHBOARD_AFTER","PARTICIPANTS_BEFORE","PARTICIPANTS_AFTER","PAGINATION_CHECK"].includes(line)) {
          section=line;sections[section]={ms:0,bytes:0,statements:0,data:[]};
        } else if(section&&line.startsWith("Time:")) {
          sections[section].ms+=Number(line.match(/Time: ([\d.]+)/)[1]);
          sections[section].statements++;
        } else if(section&&/^(?:\{|\[|\d+$)/.test(line)) {
          sections[section].bytes+=Buffer.byteLength(line);
          sections[section].data.push(JSON.parse(line));
        }
      }
      for(const prefix of ["DASHBOARD","PARTICIPANTS"]) {
        const before=sections[`${prefix}_BEFORE`],after=sections[`${prefix}_AFTER`];
        assert.equal(after.statements,1);assert.ok(after.bytes<before.bytes);
        console.log(`OFFLINE ${prefix}: SQL statements ${before.statements}->${after.statements}; `+
          `payload bytes ${before.bytes}->${after.bytes}; SQL time ${before.ms.toFixed(3)}->${after.ms.toFixed(3)} ms `+
          "(one synthetic run, private Unix socket; not HTTP/Production latency)");
      }
      const tied=sections.DASHBOARD_AFTER.data[0].rows;
      const expectedTies=Array.from({length:4000},(_,i)=>{
        const hex=createHash("md5").update(`admin-benchmark-${i+1}`).digest("hex");
        return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
      }).sort().slice(0,20);
      assert.ok(tied.every(row=>Date.parse(row.last_activity_at)===Date.parse("2098-01-01T00:00:00Z")));
      assert.deepEqual(tied.map(row=>row.id),expectedTies);
      const [lastSessions,lastParticipants]=sections.PAGINATION_CHECK.data;
      assert.equal(lastSessions.page,lastSessions.pages);assert.equal(lastSessions.rows.length,9);
      assert.equal(lastParticipants.page,lastParticipants.pages);
      assert.equal(lastParticipants.rows.length,(existingIds.length+80)%20);
      assert.equal(snapshot("profiles"),benchmarkProfilesBefore);
      const write = load("src/lib/admin/research-workbook.ts").writeResearchWorkbook;
      for (const kind of ["session", "participant"]) {
        await assert.rejects(write(client, { kind, id: kind === "session" ? f.session : owner },
          join(directory, "forbidden.xlsx")), /EXPORT-RESEARCH-ONLY/);
      }
      const workbookPath = join(directory, "research.xlsx");
      await write(client, { kind: "sessions" }, workbookPath);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(workbookPath);
      assert.equal(workbook.getWorksheet("Sessions").rowCount, 10);
      for (const sheet of workbook.worksheets) for (const row of sheet.getSheetValues()) {
        assert.ok(!JSON.stringify(row)?.includes("T01"));
        assert.ok(!JSON.stringify(row)?.includes(f.session));
      }
      for (const [table, value] of baselines) {
        assert.equal(snapshot(table), value, table);
      }
    });
  } finally {
    if (started) execFileSync(join(bin, "pg_ctl"), ["-D", directory, "-m", "immediate", "-w", "stop"], { env, stdio: "pipe" });
    rmSync(directory, { recursive: true, force: true });
  }
});
