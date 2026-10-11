import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { URL } from "node:url";
import process from "node:process";
import console from "node:console";
import ts from "typescript";
import { typescriptLoader } from "./helpers/typescript-loader.mjs";

const root = new URL("..", import.meta.url);
const user = "10000000-0000-4000-8000-000000000001";
const session = "20000000-0000-4000-8000-000000000001";
const question = "30000000-0000-4000-8000-000000000001";
const image = "40000000-0000-4000-8000-000000000001";
const snapshot = { id: session, participant_id: user, status: "in_progress", requested_question_count: 1 };
const require = createRequire(import.meta.url);
const { Response } = globalThis;
const metrics = typescriptLoader()("src/lib/performance/request.ts");

test("real React server renders deduplicate auth/profile and isolate concurrent users and failed sessions", () => {
  // Use the installed Next RSC renderer, not a mock implementation of React.cache.
  const result = execFileSync(process.execPath, ["--conditions=react-server", "--input-type=module", "-e", `
    import {AsyncLocalStorage} from 'node:async_hooks';
    import assert from 'node:assert/strict';
    import React from 'react';
    import {renderToReadableStream} from 'next/dist/compiled/react-server-dom-turbopack/server.node.js';
    import {typescriptLoader} from './tests/helpers/typescript-loader.mjs';
    const context=new AsyncLocalStorage(), counts={auth:0,profile:0,logs:0};
    const {requireRole}=typescriptLoader({
      'next/navigation':{redirect(path){throw new Error('REDIRECT:'+path)}},
      '@/lib/supabase/server':{createSupabaseServerClient:async()=>{
        const identity=context.getStore();
        return {auth:{getUser:async()=>{counts.auth++;await new Promise(r=>setTimeout(r,10));
          return {data:{user:identity.expired?null:{id:identity.id}},error:identity.expired?
            {name:'AuthApiError',status:400,code:'refresh_token_not_found'}:null}}},
          from(){counts.profile++;return {select(){return this},eq(){return this},
            maybeSingle:async()=>({data:{role:identity.role,status:identity.inactive?'deactivated':'active'},error:null})}}};
      }},
      '@/lib/errors/report':{reportError:async()=>{counts.logs++}},
    })('src/lib/auth/role.ts');
    async function run(identity,expected=identity.role){
      let observed;
      async function Page(){
        const checks=await Promise.allSettled([requireRole(expected),requireRole(expected)]);
        observed=checks.map(x=>x.status==='fulfilled'?x.value.user.id:x.reason.message);
        return React.createElement('p',null,'synthetic');
      }
      await context.run(identity,async()=>{
        const stream=await renderToReadableStream(React.createElement(Page),{}, {onError(){throw new Error('Render failed')}});
        await new Response(stream).text();
      });
      return observed;
    }
    const users=await Promise.all([run({id:'synthetic-admin',role:'admin'}),
      run({id:'synthetic-participant',role:'participant'})]);
    assert.deepEqual(users,[['synthetic-admin','synthetic-admin'],['synthetic-participant','synthetic-participant']]);
    assert.deepEqual(counts,{auth:2,profile:2,logs:0});
    assert.deepEqual(await run({id:'expired',role:'admin',expired:true}),
      ['REDIRECT:/login?error=AUTH-005','REDIRECT:/login?error=AUTH-005']);
    assert.equal(counts.logs,1);
    assert.deepEqual(await run({id:'inactive',role:'admin',inactive:true}),
      ['REDIRECT:/login?error=AUTH-002','REDIRECT:/login?error=AUTH-002']);
    assert.deepEqual(await run({id:'wrong-role',role:'participant'},'admin'),['REDIRECT:/','REDIRECT:/']);
    // A later server request must authenticate again.
    await run({id:'synthetic-admin',role:'admin'});
    assert.equal(counts.auth,6);assert.equal(counts.profile,5);
    console.log(JSON.stringify(counts));
  `], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } });
  assert.equal(JSON.parse(result.trim().split("\n").at(-1)).auth, 6);
});

test("timing logs contain only categories/counters/random correlation IDs, including HTTP and transport failures", async t => {
  const logs = [];
  t.mock.method(console, "info", (...args) => logs.push(args));
  const instrumented = metrics.instrumentSupabaseFetch(metrics.createRequestMetrics("server"), async input => {
    if (String(input).includes("throw")) throw new Error("PRIVATE_ERROR_DETAIL");
    return new Response("PRIVATE_RESEARCH_ANSWER", { status: String(input).includes("fail") ? 401 : 200 });
  });
  await instrumented("https://offline.invalid/auth/v1/user?token=PRIVATE_TOKEN");
  await instrumented("https://offline.invalid/rest/v1/answers?participant_id=PRIVATE_ID&select=answer");
  await instrumented("https://offline.invalid/auth/v1/fail", { headers: { Authorization: "PRIVATE_TOKEN" } });
  await assert.rejects(instrumented("https://offline.invalid/storage/v1/throw"), /PRIVATE_ERROR_DETAIL/);
  assert.deepEqual(logs.map(x => x[1].category), ["auth", "db", "auth", "storage"]);
  assert.equal(logs[2][1].calls, 2);
  assert.equal(logs[2][1].failed, true); assert.equal(logs[3][1].failed, true);
  assert.equal(new Set(logs.map(x => x[1].requestId)).size, 1);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_|offline\.invalid|participant_id|Authorization/);
  assert.notEqual(metrics.createRequestMetrics("server").requestId, logs[0][1].requestId);
});

function client(latency = 0, invalid = {}) {
  const calls = [];
  const rows = {
    sessions: snapshot, question_generation_attempts: [],
    questions: [{ id: question, slot_index: 1, question_text: "Synthetic question", status: "answered", regeneration_index: 1 }],
    session_images: [{ id: image, storage_path: `${user}/${session}/synthetic.png`, sort_order: 0, width: 100, height: 100 }],
    question_targets: [{ question_id: question, image_id: image, x: 0.1, y: 0.1, width: 0.2, height: 0.2, sort_order: 0 }],
    answers: [{ question_id: question, original_answer: "Synthetic original", refined_answer: "Synthetic refined",
      refinement_used: true, current_answer_version: "refined", updated_at: "2026-10-11T09:00:00.123456+00:00" }],
    ...invalid,
  };
  const respond = async (name, data) => { calls.push(name); if (latency) await delay(latency); return { data, error: null }; };
  return { calls,
    from(table) {
      const query = { select() { return this; }, eq() { return this; }, in() { return this; },
        order() { return this; }, limit() { return this; },
        maybeSingle() { return respond(table, rows[table]); },
        then(resolve, reject) { return respond(table, rows[table]).then(resolve, reject); },
      }; return query;
    },
    rpc() { return respond("capabilities", { ready: false, reserve_count: 0, reserve_count_by_question: { [question]: 0 } }); },
    storage: { from() { return { createSignedUrl: () => respond("signed_url", { signedUrl: "https://offline.invalid/image" }) }; } },
  };
}

function baseline() {
  const source = execFileSync("git", ["show", "e32d58dca7a9503df9e13929101babda84fafa25:src/lib/question-generation/read.ts"],
    { cwd: root, encoding: "utf8" });
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const load = typescriptLoader();
  const m = { exports: {} };
  runInThisContext(`(function(require,module,exports){${js}\n})`)(name => name === "server-only" ? {} :
    name.startsWith("..") ? load(new URL(`${name}.ts`, new URL("../src/lib/question-generation/read.ts", import.meta.url))) :
      name.startsWith(".") ? load(new URL(`${name}.ts`, new URL("../src/lib/question-generation/read.ts", import.meta.url))) :
        require(name), m, m.exports);
  return m.exports.readGenerationView;
}

test("same synthetic network latency benchmark preserves result and reduces completed-entry calls/critical path", async t => {
  const before = baseline();
  const after = typescriptLoader()("src/lib/question-generation/read.ts").readGenerationView;
  const measurements = { before: [], after: [] };
  for (let i = 0; i < 5; i++) {
    const oldClient = client(15), newClient = client(15);
    let started = performance.now();
    // The old page separately read the same owned session.
    await oldClient.from("sessions").select().maybeSingle();
    const original = await before(oldClient, user, session);
    measurements.before.push(performance.now() - started);
    started = performance.now();
    const saved = await newClient.from("sessions").select().maybeSingle();
    const optimized = await after(newClient, user, session, saved.data);
    measurements.after.push(performance.now() - started);
    assert.deepEqual(optimized, original);
    assert.equal(oldClient.calls.length, 9); assert.equal(newClient.calls.length, 8);
    assert.equal(newClient.calls.filter(c => c === "sessions").length, 1);
  }
  const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
  t.diagnostic(JSON.stringify({ environment: "offline synthetic 15ms per request, 5 paired samples",
    beforeRequests: 9, afterRequests: 8, beforeMeanMs: mean(measurements.before),
    afterMeanMs: mean(measurements.after) }));
});

test("saved session snapshot cannot cross ownership or session boundaries and invalid data remains fail-closed", async () => {
  const { readGenerationView } = typescriptLoader()("src/lib/question-generation/read.ts");
  for (const saved of [{ ...snapshot, participant_id: image }, { ...snapshot, id: image },
    { ...snapshot, status: "invalid" }]) {
    const db = client();
    await assert.rejects(readGenerationView(db, user, session, saved), e => e.code === "QGEN-AUTH");
    assert.deepEqual(db.calls, []);
  }
  const broken = client(0, { question_targets: [], answers: [] });
  await assert.rejects(readGenerationView(broken, user, session, snapshot), e => e.code === "QGEN-RECOVERY");
});

test("proxy auth remains independent and request caching has no global cross-user cache", () => {
  const source = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(source, /await supabase\.auth\.getUser\(\)/);
  const role = readFileSync(new URL("../src/lib/auth/role.ts", import.meta.url), "utf8");
  assert.match(role, /cache\(async \(\) =>/);
  assert.doesNotMatch(role, /unstable_cache|use cache|new Map|globalThis/);
});
