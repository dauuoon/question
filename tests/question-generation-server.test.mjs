import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { URL } from "node:url";
import console from "node:console";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

const require = createRequire(import.meta.url);
const { AbortController, structuredClone, setTimeout } = globalThis;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
function loader(overrides = {}) {
  const cache = new Map();
  function load(path) {
    const url = path instanceof URL ? path : new URL(`../${path}`, import.meta.url);
    if (cache.has(url.href)) return cache.get(url.href);
    const module = { exports: {} }; cache.set(url.href, module.exports);
    const compiled = ts.transpileModule(readFileSync(url, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
      (name) => {
        if (Object.hasOwn(overrides, name)) return overrides[name];
        if (name === "server-only") return {};
        if (name.startsWith("@/")) return load(`src/${name.slice(2)}.ts`);
        if (name.startsWith(".")) return load(new URL(`${name}.ts`, url));
        return require(name);
      }, module, module.exports);
    cache.set(url.href, module.exports);
    return module.exports;
  }
  return load;
}
const load = loader();
const contract = load("src/lib/ai/question-generation-contract.ts");
const config = load("src/lib/ai/server/question-generation-config.ts");
const validation = load("src/lib/ai/server/question-generation-validation.ts");
const provider = load("src/lib/ai/server/question-generation.ts");
const service = load("src/lib/ai/server/question-generation-service.ts");
const schema = load("src/lib/ai/schemas/question-generation-v2.0.ts").QUESTION_GENERATION_SCHEMA;
const prompt = load("src/lib/ai/prompts/question-generation-v2.5.ts");
const owner = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const sessionId = "20000000-0000-4000-8000-000000000001";
const requestId = "40000000-0000-4000-8000-000000000001";
const input = { session_id: sessionId, request_id: requestId };
const saved = {
  primary_category_id: "ux_ui", subcategory_id: "web_design", other_category_text: null,
  stage_id: "idea_concept", additional_context: "PRIVATE TEST CONTEXT", context_ids: ["visual_form"],
};
const snapshot = (n = 3) => ({
  id: randomUUID(), session_id: sessionId, request_id: requestId, status: "running",
  input_snapshot: structuredClone(saved), requested_question_count: n, validated_candidates: null,
  image_snapshot: [1, 2].map((i) => ({
    id: `30000000-0000-4000-8000-00000000000${i}`, sort_order: i - 1,
    storage_path: `${owner}/${sessionId}/TEST-${i}.png`, mime_type: "image/png",
    file_size: 100, width: 128, height: 96,
  })),
});
const candidates = () => Array.from({ length: 5 }, (_, i) => ({
  candidate_rank: i + 1, question_text: `TEST question ${i + 1}?`,
  content_principle: "사고의 자각과 외재화", question_type: "자기인식 질문",
  related_contexts: i === 0 ? ["시각적·형태적 표현을 살펴보고 싶어요"] : [],
  answer_guides: [], target: { type: "image", image_indices: [1], region: null },
}));
const generated = () => ({ output: { questions: candidates() }, model: "returned-model", generatedAt: "2026-10-08T00:00:00.000Z" });
const dependencies = (overrides = {}) => ({
  config: () => ({ apiKey: "mock-only", model: "configured-model" }),
  generate: async () => generated(), ...overrides,
});
const run = (repo, value = input, deps = dependencies(), signal = new AbortController().signal) =>
  service.runQuestionGeneration(repo, value, signal, deps);

function memory(n = 3) {
  let attempt = null, calls = 0, commits = 0, materialized = [];
  const failures = [];
  return {
    failures, get calls() { return calls; }, get commits() { return commits; },
    get current() { return attempt; }, get questions() { return materialized; },
    async begin(value) {
      if (attempt) return { attempt_id: attempt.id, status: attempt.status, acquired: false };
      attempt = snapshot(n); attempt.request_id = value.request_id;
      return { attempt_id: attempt.id, status: attempt.status, acquired: true };
    },
    async attempt() { return structuredClone(attempt); },
    async images() { return ["https://signed.invalid/1", "https://signed.invalid/2"]; },
    async stage(value, items) { attempt.validated_candidates = items; },
    async commit() {
      if (attempt.status === "completed") return;
      commits++; materialized = Array.from({ length: n }, () => randomUUID()); attempt.status = "completed";
    },
    async completed() { return materialized; },
    async fail(id, request, code) { failures.push({ id, request, code }); attempt.status = "failed"; },
    deps(overrides = {}) { return dependencies({ generate: async (...args) => {
      calls++; return overrides.generate ? overrides.generate(...args) : generated();
    }, ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "generate")) }); },
  };
}

test("request rejects client overrides; config uses only separate server model; frozen artifacts unchanged", () => {
  assert.equal(contract.questionGenerationRequestSchema.safeParse(input).success, true);
  for (const key of ["model", "prompt", "schema", "candidate_count", "image_urls", "storage_paths",
    "user_id", "participant_id", "candidate_rank", "questions", "requested_question_count", "input"]) {
    assert.equal(contract.questionGenerationRequestSchema.safeParse({ ...input, [key]: "injected" }).success, false);
  }
  assert.throws(() => config.questionGenerationConfig({
    OPENAI_API_KEY: "mock-only", OPENAI_CONTEXT_DRAFT_MODEL: "must-not-fallback",
  }), (e) => e.code === "QGEN-CONFIG");
  assert.equal(config.questionGenerationConfig({
    OPENAI_API_KEY: "mock-only", OPENAI_QUESTION_GENERATION_MODEL: "gpt-6-astra",
  }).model, "gpt-6-astra");
  for (const [path, hash] of [
    ["prompts/question-generation-v2.5.ts", "9dcb960bcf7ee04a9878829a1ea86492cbc0d40723f3d82bc33de33091081cae"],
    ["schemas/question-generation-v2.0.ts", "0fe9c5ce02cbe5cdc03415b7b8d68c58ca049d40a6a4d6d192ebd454b3833d49"],
    ["prompts/context-draft-v1.0.ts", "fcc2f23abc35becaf02a520cd2768cbb35c0ed6809a9af143dd8e3451a82d8be"],
  ]) assert.equal(createHash("sha256").update(read(`src/lib/ai/${path}`)).digest("hex"), hash);
});

test("strict validation rejects shape/ranks/enums/hierarchy/guides/targets and top-N context coverage without repairing output", () => {
  const bad = [
    (v) => { v.pop(); }, (v) => { v[1].candidate_rank = 1; },
    (v) => { delete v[0].candidate_rank; }, (v) => { v.reverse(); },
    (v) => { v[0].content_principle = "unknown"; },
    (v) => { v[0].question_type = "unknown"; },
    (v) => { v[0].question_type = "목표 및 전략 조절 질문"; },
    (v) => { v[0].question_text = " "; }, (v) => { v[1].question_text = v[0].question_text; },
    (v) => { v[0].answer_guides = [""]; }, (v) => { v[0].answer_guides = ["a", "b", "c", "d"]; },
    (v) => { v[0].target.image_indices = [3]; },
    (v) => { v[0].target.image_indices = [1, 1]; },
    (v) => { v[0].target.type = "multi_image"; },
    (v) => { v[0].target.region = { x: 0, y: 0, width: 1, height: 1 }; },
    (v) => { v[0].target = { type: "region", image_indices: [1], region: { x: 0.9, y: 0, width: 0.2, height: 0.3 } }; },
    (v) => { v[0].target = { type: "region", image_indices: [1], region: { x: 0, y: 0, width: 0, height: 1 } }; },
    (v) => { v[0].extra = "not allowed"; },
    (v) => { v[0].question_text = "x".repeat(250 * 1024); },
  ];
  for (const mutate of bad) {
    const value = candidates(); mutate(value);
    assert.throws(() => validation.validateQuestionOutput({ questions: value }, snapshot()), (e) => e.code === "QGEN-VALIDATION");
  }
  assert.throws(() => validation.validateQuestionOutput({ questions: candidates(), rationale: "no" }, snapshot()));
  for (const related of [["unknown"], ["problem_and_goal"], ["visual_form", "시각적·형태적 표현을 살펴보고 싶어요"], []]) {
    const value = candidates(); value[0].related_contexts = related;
    assert.throws(() => validation.validateQuestionOutput({ questions: value }, snapshot()), (e) => e.code === "QGEN-CONTEXT");
  }
  assert.deepEqual(validation.normalizeRelatedContexts(["visual_form"], saved.context_ids), ["visual_form"]);
  assert.deepEqual(validation.normalizeRelatedContexts(["시각적·형태적 표현을 살펴보고 싶어요"], saved.context_ids), ["visual_form"]);
});

test("Responses request preserves frozen schema/prompt, saved labels/context, sorted images, five candidates for every N", async () => {
  for (const n of [1, 3, 5]) {
    const params = provider.questionGenerationParameters("configured-model", snapshot(n), ["signed-1", "signed-2"]);
    assert.equal(params.instructions, prompt.QUESTION_GENERATION_PROMPT);
    assert.deepEqual(params.text.format, { type: "json_schema", ...schema });
    assert.equal(params.store, false); assert.equal(params.stream, false);
    assert.equal(params.model, "configured-model");
    const content = params.input[0].content;
    assert.match(content[0].text, /웹 디자인|PRIVATE TEST CONTEXT/);
    assert.match(content[0].text, new RegExp(`"requested_question_count":${n}`));
    assert.deepEqual(content.filter((c) => c.type === "input_image").map((c) => c.image_url), ["signed-1", "signed-2"]);
    assert.deepEqual(content.filter((c) => c.type === "input_text").slice(1).map((c) => c.text),
      ["image_index: 1", "image_index: 2"]);
  }
  const sdkCalls = [];
  class FakeOpenAI {
    static APIError = require("openai").default.APIError;
    static APIConnectionTimeoutError = require("openai").default.APIConnectionTimeoutError;
    constructor(settings) { this.responses = { create: async (params, options) => {
      sdkCalls.push({ settings, params, options });
      return { status: "completed", model: "actual-model", created_at: 1791417600, output: [
        { type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ questions: candidates() }) }] },
      ] };
    } }; }
  }
  const fake = loader({ openai: { default: FakeOpenAI } })("src/lib/ai/server/question-generation.ts");
  const signal = new AbortController().signal;
  const result = await fake.generateQuestions({ apiKey: "mock-only", model: "configured-model" }, snapshot(), ["a", "b"], signal);
  assert.equal(result.model, "actual-model");
  assert.equal(sdkCalls.length, 1); assert.equal(sdkCalls[0].settings.maxRetries, 0);
  assert.equal(sdkCalls[0].settings.logLevel, "off"); assert.equal(sdkCalls[0].settings.timeout, 60000);
  assert.equal(sdkCalls[0].options.signal, signal);
});

test("same-ID and concurrent different-ID requests call provider exactly once; completed replay returns same IDs", async () => {
  const repo = memory();
  let resolve, entered;
  const pending = new Promise((r) => { resolve = r; });
  const started = new Promise((r) => { entered = r; });
  const deps = repo.deps({ generate: async () => { entered(); return pending; } });
  const first = run(repo, input, deps); await started;
  for (const request_id of [requestId, randomUUID()]) {
    const replay = await run(repo, { ...input, request_id }, deps);
    assert.equal(replay.status, "running"); assert.equal(repo.calls, 1);
  }
  resolve(generated()); const result = await first;
  assert.equal(result.status, "completed"); assert.equal(repo.current.status, "completed");
  for (const request_id of [requestId, randomUUID()]) {
    const replay = await run(repo, { ...input, request_id }, deps);
    assert.deepEqual(replay.question_ids, result.question_ids); assert.equal(repo.calls, 1);
  }
  assert.equal(repo.commits, 1);
});

test("pre-stage image/refusal/incomplete/validation/config failures release acquired attempt; failed same ID never recalls", async () => {
  for (const code of ["QGEN-IMAGE", "QGEN-REFUSAL", "QGEN-INCOMPLETE", "QGEN-API", "QGEN-RATE", "QGEN-CONFIG"]) {
    const repo = memory();
    if (code === "QGEN-IMAGE") repo.images = async () => { throw new contract.QuestionGenerationError(code); };
    const deps = repo.deps({ generate: async () => { throw new contract.QuestionGenerationError(code); } });
    await assert.rejects(run(repo, input, deps), (e) => e.code === code);
    assert.equal(repo.current.status, "failed"); assert.equal(repo.failures.length, 1);
    assert.equal(repo.current.validated_candidates, null);
    if (code === "QGEN-IMAGE") assert.equal(repo.calls, 0);
    await assert.rejects(run(repo, input, deps), (e) => e.code === "QGEN-FAILED");
  }
  const repo = memory();
  await assert.rejects(run(repo, input, repo.deps({ generate: async () => ({ ...generated(), output: { questions: [] } }) })),
    (e) => e.code === "QGEN-VALIDATION");
  assert.equal(repo.failures[0].code, "QGEN-VALIDATION");
});

test("provider refusal/incomplete/invalid JSON are explicit errors, never an empty success", () => {
  const completed = { status: "completed", model: "actual", created_at: 1791417600 };
  for (const [status, content, code] of [
    ["completed", [{ type: "refusal", refusal: "no" }], "QGEN-REFUSAL"],
    ["incomplete", [{ type: "output_text", text: "{}" }], "QGEN-INCOMPLETE"],
    ["completed", [{ type: "output_text", text: "```json\n{}\n```" }], "QGEN-VALIDATION"],
    ["completed", [], "QGEN-VALIDATION"],
  ]) assert.throws(() => provider.extractQuestionOutput({
    ...completed, status, output: [{ type: "message", status: "completed", content }],
  }), (e) => e.code === code);
});

test("hanging provider and aborted request use independent bounded cleanup; cleanup failures are visible", async () => {
  for (const reason of ["timeout", "cancelled"]) {
    const repo = memory(), controller = new AbortController();
    const promise = run(repo, input, repo.deps({ generate: () => new Promise(() => {}) }), controller.signal);
    setTimeout(() => controller.abort(reason), 10);
    await assert.rejects(promise, (e) => e.code === (reason === "timeout" ? "QGEN-TIMEOUT" : "QGEN-CANCELLED"));
    assert.equal(repo.current.status, "failed");
    assert.equal(repo.failures[0].code, reason === "timeout" ? "QGEN-TIMEOUT" : "QGEN-CANCELLED");
  }
  const repo = memory(); repo.fail = async () => { throw new Error("private provider error"); };
  await assert.rejects(run(repo, input, repo.deps({ generate: async () => { throw new Error("secret"); } })),
    (e) => e.code === "QGEN-RECOVERY" && !e.message.includes("secret"));
});

test("ambiguous begin never invents execution rights, calls provider or fails another runner; aborted-before-start does not dispatch", async () => {
  const repo = memory(), original = repo.begin;
  repo.begin = async (...args) => { await original(...args); throw new contract.QuestionGenerationError("QGEN-DB", 503); };
  await assert.rejects(run(repo, input, repo.deps()), (e) => e.code === "QGEN-RECOVERY");
  assert.equal(repo.calls, 0); assert.equal(repo.failures.length, 0); assert.equal(repo.current.status, "running");
  repo.begin = original;
  assert.equal((await run(repo, input, repo.deps())).status, "running"); assert.equal(repo.calls, 0);
  const fresh = memory(), controller = new AbortController();
  controller.abort("cancelled");
  await assert.rejects(run(fresh, input, fresh.deps(), controller.signal), (e) => e.code === "QGEN-CANCELLED");
  assert.equal(fresh.current, null); assert.equal(fresh.calls, 0);
});

test("confirmed stage failure releases lock; ambiguous stage preserves lock; lost stage response recovers without recall", async () => {
  const rejected = memory();
  rejected.stage = async () => { throw new service.QuestionStageError(true); };
  await assert.rejects(run(rejected, input, rejected.deps()), (e) => e.code === "QGEN-STAGE");
  assert.equal(rejected.current.status, "failed");
  const ambiguous = memory();
  ambiguous.stage = async () => { throw new service.QuestionStageError(false); };
  await assert.rejects(run(ambiguous, input, ambiguous.deps()), (e) => e.code === "QGEN-RECOVERY");
  assert.equal(ambiguous.current.status, "running"); assert.equal(ambiguous.failures.length, 0);
  const lost = memory(), stage = lost.stage;
  lost.stage = async (...args) => { await stage(...args); throw new service.QuestionStageError(false); };
  await assert.rejects(run(lost, input, lost.deps()), (e) => e.code === "QGEN-STAGE");
  assert.ok(lost.current.validated_candidates); assert.equal(lost.failures.length, 0);
  assert.equal((await run(lost, input, lost.deps())).status, "completed"); assert.equal(lost.calls, 1);
});

test("commit failure and lost success response retain stage; retry with other request uses stored original ID without provider recall", async () => {
  for (const committed of [false, true]) {
    const repo = memory(), original = repo.commit;
    repo.commit = async (...args) => {
      if (committed) await original(...args);
      throw new contract.QuestionGenerationError("QGEN-COMMIT", 503);
    };
    await assert.rejects(run(repo, input, repo.deps()), (e) => e.code === "QGEN-COMMIT");
    assert.equal(repo.failures.length, 0); assert.ok(repo.current.validated_candidates);
    repo.commit = original;
    const replay = await run(repo, { ...input, request_id: randomUUID() }, repo.deps());
    assert.equal(replay.status, "completed"); assert.equal(repo.calls, 1); assert.equal(repo.commits, 1);
  }
});

async function databaseFixture(n = 3) {
  const db = new PGlite();
  await db.exec(read("tests/question-generation-db.test.mjs").match(/await db.exec\(`([\s\S]*?)`\);/)[1]);
  for (const [i, file] of [
    "20261003201500_phase1_schema.sql", "20261003201600_phase1_rls.sql",
    "20261003233000_storage_upload_slots.sql", "20261004150000_participant_last_activity.sql",
    "20261005190000_session_context_save.sql", "20261005231000_context_draft_claim.sql",
    "20261006031000_image_deletion.sql", "20261008031500_question_generation_foundation.sql",
  ].entries()) await db.exec(i === 0 ? read(`supabase/migrations/${file}`).replace(
    "create extension if not exists pgcrypto with schema extensions;", "") : read(`supabase/migrations/${file}`));
  await db.exec(`insert into auth.users values('${owner}'),('${other}');
    insert into public.profiles(id,participant_code) values('${owner}','P99001'),('${other}','P99002');
    insert into public.sessions(id,participant_id,requested_question_count) values('${sessionId}','${owner}',${n});`);
  let queue = Promise.resolve();
  const query = (role, who, sql, params = []) => {
    const operation = queue.then(async () => {
      await db.exec(`set role ${role};select set_config('request.jwt.claim.sub','${who}',false),
        set_config('request.jwt.claim.role','${role}',false);`);
      try { return await db.query(sql, params); }
      finally { await db.exec("reset role;"); }
    });
    queue = operation.catch(() => {});
    return operation;
  };
  const rpc = (role, who, name, args) => query(role, who,
    `select public.${name}(${Object.keys(args).map((key, i) => `${key} => $${i + 1}`).join(",")}) result`,
    Object.values(args).map((v) => Array.isArray(v) && typeof v[0] === "object" ? JSON.stringify(v) : v))
    .then((r) => ({ data: r.rows[0].result, error: null }), (e) => ({ data: null, error: { code: e.code } }));
  await rpc("authenticated", owner, "save_session_context", {
    p_session_id: sessionId, p_primary_category_id: "ux_ui", p_subcategory_id: "web_design",
    p_other_category_text: null, p_stage_id: "idea_concept", p_additional_context: saved.additional_context,
    p_context_ids: ["visual_form"],
  });
  for (let i = 1; i <= 2; i++) {
    const id = `30000000-0000-4000-8000-00000000000${i}`;
    const slot = (await query("authenticated", owner, "select * from public.reserve_image_upload($1,$2,'png',$3)",
      [sessionId, id, "a".repeat(64)])).rows[0];
    await query("authenticated", owner, `insert into storage.objects(bucket_id,name,metadata)
      values('why-box-images',$1,'{"mimetype":"image/png","size":100}')`, [slot.storage_path]);
    await query("authenticated", owner, `insert into public.session_images(id,session_id,storage_path,original_filename,
      mime_type,file_size,width,height,sort_order) values($1,$2,$3,'TEST.png','image/png',100,128,96,$4)`,
    [id, sessionId, slot.storage_path, slot.sort_order]);
  }
  const calls = [];
  function client(role = "authenticated", who = owner) {
    return {
      rpc(name, args) { calls.push({ role, name, args });
        const operation = rpc(role, who, name, args); operation.abortSignal = () => operation; return operation; },
      from(table) {
        let columns = "*", single = false, order = "", filters = [], params = [];
        const q = {
          select(value) { columns = value; return q; },
          eq(key, value) { params.push(value); filters.push(`${key}=$${params.length}`); return q; },
          in(key, values) { params.push(values); filters.push(`${key}=any($${params.length})`); return q; },
          order(key) { order = ` order by ${key}`; return q; },
          abortSignal() { return q; }, maybeSingle() { single = true; return q; },
          then(resolve, reject) {
            return query(role, who, `select ${columns} from public.${table}${filters.length ? ` where ${filters.join(" and ")}` : ""}${order}`, params)
              .then((r) => ({ data: single ? r.rows[0] ?? null : r.rows, error: null }),
                (e) => ({ data: null, error: { code: e.code } })).then(resolve, reject);
          },
        }; return q;
      },
      storage: { from(bucket) {
        assert.equal(role, "authenticated"); assert.equal(bucket, "why-box-images");
        return {
          async list(folder, options) {
            const r = await query(role, who, "select id,name from storage.objects where bucket_id=$1 and name=$2",
              [bucket, `${folder}/${options.search}`]);
            return { data: r.rows.map((r) => ({ ...r, name: r.name.split("/").at(-1) })), error: null };
          },
          async createSignedUrl(path, ttl) {
            calls.push({ role, signing: true, path, ttl });
            return { data: { signedUrl: `https://signed.invalid/${path}` }, error: null };
          },
        };
      } },
    };
  }
  return { db, client, calls, query, repo: service.createGenerationRepository(client(), client("service_role"), owner) };
}

for (const n of [1, 3, 5]) test(`actual RPC-backed server pipeline N=${n}: five candidates, N originals, context IDs/provenance/in_progress and replay`, async () => {
  const s = await databaseFixture(n);
  try {
    let providerCalls = 0;
    const deps = dependencies({ generate: async () => { providerCalls++; return generated(); } });
    const first = await run(s.repo, input, deps);
    assert.equal(first.question_ids.length, n);
    const counts = (await s.db.query(`select
      (select count(*)::int from public.question_candidates) candidates,
      (select count(*)::int from public.questions) questions,
      (select count(*)::int from public.question_targets) targets,
      (select status from public.sessions) status,
      (select status from public.question_generation_attempts) attempt`)).rows[0];
    assert.deepEqual(counts, { candidates: 5, questions: n, targets: n, status: "in_progress", attempt: "completed" });
    const rows = (await s.db.query("select slot_index,selection_reason from public.questions order by slot_index")).rows;
    for (const [i, q] of rows.entries()) assert.equal(q.selection_reason,
      `system:initial_top_n;candidate_rank=${i + 1};requested_question_count=${n}`);
    assert.deepEqual((await s.db.query("select context_ids from public.question_candidates where candidate_rank=1")).rows[0].context_ids, ["visual_form"]);
    assert.deepEqual((await run(s.repo, { ...input, request_id: randomUUID() }, deps)).question_ids, first.question_ids);
    assert.equal(providerCalls, 1);
    assert.ok(s.calls.filter((c) => c.name === "begin_question_generation").every((c) => c.role === "authenticated"));
    assert.ok(s.calls.filter((c) => ["stage_question_generation_candidates", "commit_question_generation"].includes(c.name))
      .every((c) => c.role === "service_role" && c.args.p_request_id === requestId));
    assert.ok(s.calls.filter((c) => c.signing).every((c) => c.role === "authenticated" && c.ttl === 180));
  } finally { await s.db.close(); }
});

test("actual begin denies wrong owner and inactive participant; no provider/stage calls", async () => {
  const s = await databaseFixture();
  try {
    for (const inactive of [false, true]) {
      if (inactive) await s.db.query("update public.profiles set status='deactivated' where id=$1", [owner]);
      const repo = service.createGenerationRepository(s.client("authenticated", inactive ? owner : other), s.client("service_role"), owner);
      await assert.rejects(run(repo, input, dependencies({ generate: () => assert.fail("provider must not run") })),
        (e) => e.code === "QGEN-AUTH");
    }
    assert.equal((await s.db.query("select count(*)::int n from public.question_generation_attempts")).rows[0].n, 0);
  } finally { await s.db.close(); }
});

test("partial private-image preparation fails whole attempt before provider; list/sign use authenticated client only", async () => {
  const s = await databaseFixture();
  try {
    const caller = s.client(), original = caller.storage.from;
    let checked = 0, signed = 0;
    caller.storage.from = (...args) => {
      const bucket = original(...args);
      return {
        ...bucket,
        list: async (...args) => ++checked === 2 ? { data: [], error: null } : bucket.list(...args),
        createSignedUrl: async (...args) => { signed++; return bucket.createSignedUrl(...args); },
      };
    };
    const repo = service.createGenerationRepository(caller, s.client("service_role"), owner);
    await assert.rejects(run(repo, input, dependencies({ generate: () => assert.fail("partial images must not call provider") })),
      (e) => e.code === "QGEN-IMAGE");
    assert.equal(checked, 2); assert.equal(signed, 1);
    assert.equal((await s.db.query("select status from public.question_generation_attempts")).rows[0].status, "failed");
    assert.equal((await s.db.query("select count(*)::int n from public.question_candidates")).rows[0].n, 0);
  } finally { await s.db.close(); }
});

test("nullable legacy image dimensions remain compatible with deployed DB snapshot contract", async () => {
  const s = await databaseFixture();
  try {
    await s.query("authenticated", owner, "update public.session_images set width=null,height=null where session_id=$1", [sessionId]);
    assert.equal((await run(s.repo)).status, "completed");
  } finally { await s.db.close(); }
});

test("real rejected stage releases input lock; new request retry succeeds without partial rows", async () => {
  const s = await databaseFixture();
  try {
    await s.db.exec(`create function public.test_reject_stage() returns trigger language plpgsql as $$
      begin if new.validated_candidates is not null then raise exception 'TEST rejection' using errcode='22023'; end if; return new; end $$;
      create trigger test_reject_stage before update on public.question_generation_attempts for each row execute function public.test_reject_stage();`);
    await assert.rejects(run(s.repo), (e) => e.code === "QGEN-STAGE");
    assert.equal((await s.db.query("select status from public.question_generation_attempts")).rows[0].status, "failed");
    assert.equal((await s.db.query("select count(*)::int n from public.question_candidates")).rows[0].n, 0);
    await s.query("authenticated", owner, "update public.sessions set additional_context='TEST unlocked' where id=$1", [sessionId]);
    await s.db.exec("drop trigger test_reject_stage on public.question_generation_attempts; drop function public.test_reject_stage();");
    assert.equal((await run(s.repo, { ...input, request_id: randomUUID() })).status, "completed");
  } finally { await s.db.close(); }
});

test("real commit rollback retains staged candidates and recovery completes exactly once without provider recall", async () => {
  const s = await databaseFixture();
  try {
    await s.db.exec(`create function public.test_reject_commit() returns trigger language plpgsql as $$
      begin raise exception 'TEST rejection' using errcode='23514'; end $$;
      create trigger test_reject_commit before insert on public.questions for each row execute function public.test_reject_commit();`);
    let calls = 0;
    const deps = dependencies({ generate: async () => { calls++; return generated(); } });
    await assert.rejects(run(s.repo, input, deps), (e) => e.code === "QGEN-COMMIT");
    const attempt = (await s.db.query("select status,validated_candidates from public.question_generation_attempts")).rows[0];
    assert.equal(attempt.status, "running"); assert.equal(attempt.validated_candidates.length, 5);
    for (const table of ["question_candidates", "questions", "question_targets"]) {
      assert.equal((await s.db.query(`select count(*)::int n from public.${table}`)).rows[0].n, 0);
    }
    await s.db.exec("drop trigger test_reject_commit on public.questions;drop function public.test_reject_commit();");
    const recovered = await run(s.repo, { ...input, request_id: randomUUID() }, deps);
    assert.equal(recovered.question_ids.length, 3); assert.equal(calls, 1);
    assert.deepEqual((await run(s.repo, input, deps)).question_ids, recovered.question_ids); assert.equal(calls, 1);
    assert.equal((await s.db.query("select count(*)::int n from public.question_candidates")).rows[0].n, 5);
    assert.equal((await s.db.query("select status from public.sessions")).rows[0].status, "in_progress");
  } finally { await s.db.close(); }
});

test("every frozen framework type matches server hierarchy; valid region/multi-image/guide shapes preserve payload", () => {
  const groups = [4, 6, 8, 4, 5]; let offset = 0;
  for (const [index, count] of groups.entries()) {
    for (const type of schema.schema.properties.questions.items.properties.question_type.enum.slice(offset, offset + count)) {
      const value = candidates(); value[0].content_principle = schema.schema.properties.questions.items.properties.content_principle.enum[index];
      value[0].question_type = type;
      assert.deepEqual(validation.validateQuestionOutput({ questions: value }, snapshot()), value);
    }
    offset += count;
  }
  const value = candidates();
  value[0].target = { type: "region", image_indices: [2], region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } };
  value[1].target = { type: "multi_image", image_indices: [2, 1], region: null };
  value[0].answer_guides = ["여백", "색상", "정렬"];
  assert.deepEqual(validation.validateQuestionOutput({ questions: value }, snapshot()), value);
});

function routeSetup(patch = {}) {
  const logs = [], calls = [];
  const caller = {
    auth: { getUser: async () => ({ data: { user: patch.anonymous ? null : { id: owner } }, error: null }) },
    from() { const q = {
      select() { return q; }, eq() { return q; }, abortSignal() { return q; },
      maybeSingle: async () => ({ data: { role: patch.role ?? "participant", status: patch.status ?? "active" }, error: patch.profileError ?? null }),
    }; return q; },
  };
  const scoped = loader({
    "@/lib/supabase/server": { createSupabaseServerClient: async () => caller },
    "@/lib/supabase/admin": { createSupabaseAdminClient: () => { calls.push("admin"); return {}; } },
    "@/lib/ai/question-generation-contract": contract,
    "@/lib/ai/server/question-generation-config": { QUESTION_GENERATION_TIMEOUT_MS: 20 },
    "@/lib/ai/server/question-generation-service": {
      ...service, createGenerationRepository: () => patch.repo ?? memory(),
      runQuestionGeneration: (repo, input, signal) => {
        calls.push("pipeline"); return service.runQuestionGeneration(repo, input, signal,
          dependencies(patch.hang ? { generate: () => new Promise(() => {}) } : {}));
      },
    },
  });
  const route = scoped("src/app/api/question-generation/route.ts");
  const { NextRequest } = require("next/server");
  return { calls, logs, post: (value = input, origin = "http://localhost:3000") => route.POST(new NextRequest(
    "http://localhost:3000/api/question-generation", { method: "POST",
      headers: { host: "localhost:3000", origin, "Content-Type": "application/json" },
      body: typeof value === "string" ? value : JSON.stringify(value),
    })) };
}

test("route rejects unauthenticated/admin/inactive/bad origin/bad UUID/oversized/client overrides before trusted RPC access; safe logs", async (t) => {
  const logs = []; t.mock.method(console, "error", (...args) => logs.push(args));
  for (const patch of [{ anonymous: true }, { role: "admin" }, { status: "deactivated" }, { profileError: { code: "error" } }]) {
    const s = routeSetup(patch); assert.ok((await s.post()).status >= 400); assert.deepEqual(s.calls, []);
  }
  for (const [body, origin] of [[input, "https://evil.invalid"], ["bad-json"], ["x".repeat(4097)],
    [{ ...input, session_id: "bad" }], [{ ...input, model: "injected" }]]) {
    const s = routeSetup(); assert.ok((await s.post(body, origin)).status >= 400); assert.deepEqual(s.calls, []);
  }
  assert.doesNotMatch(JSON.stringify(logs), /mock-only|signed.invalid|PRIVATE TEST CONTEXT|TEST question/);
});

test("route returns only IDs/state with no-store; timeout fails attempt; UI uses eligibility", async (t) => {
  t.mock.method(console, "error", () => {});
  const s = routeSetup();
  const response = await s.post();
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["attempt_id", "question_ids", "request_id", "status"]);
  assert.doesNotMatch(JSON.stringify(body), /mock-only|signed.invalid|PRIVATE TEST CONTEXT|TEST question/);
  const repo = memory();
  const timeout = await routeSetup({ repo, hang: true }).post();
  assert.equal(timeout.status, 504); assert.equal(repo.current.status, "failed");
  assert.match(read("src/app/(participant)/sessions/[sessionId]/session-wizard.tsx"),
    /disabled=\{!eligible\} onClick=\{\(\) => void controller\.current\?\.start\(\)\}>질문 생성하기<\/button>/);
});
