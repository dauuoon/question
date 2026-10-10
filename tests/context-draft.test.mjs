import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import console from "node:console";
import { runInThisContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { AbortController, Headers, Response } = globalThis;
function load(path, mocks = {}) {
  mocks = { "@/app/toast": { Toast: () => null }, "next/navigation": { useRouter: () => ({ push() {} }) }, ...mocks };
  mocks["@/app/category-select"] = { CategorySelect: () => null };
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
    (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name), module, module.exports);
  return module.exports;
}
const options = load("../src/lib/constants/research-options.ts");
const inputModule = load("../src/lib/session-context/input.ts", { "../constants/research-options": options });
const wizard = load("../src/lib/session-context/wizard.ts", { "../constants/research-options": options });
const contract = load("../src/lib/ai/context-draft-contract.ts", {
  "../session-context/input": inputModule, "../session-context/wizard": wizard,
});
const { ContextDraftController, requestContextDraft } = load("../src/lib/session-context/context-draft-controller.ts", {
  "../ai/context-draft-contract": contract,
});
const { ContextAutosave } = load("../src/lib/session-context/autosave.ts", { "./input": inputModule });
const prompt = load("../src/lib/ai/prompts/context-draft-v1.0.ts");
const config = load("../src/lib/ai/server/config.ts", { "server-only": {}, "../context-draft-contract": contract });
const OpenAI = require("openai").default;
let sdkResult, sdkError, sdkCalls = [];
class FakeOpenAI {
  constructor(settings) {
    this.responses = { create: async (params, requestOptions) => {
      sdkCalls.push({ settings, params, requestOptions });
      if (sdkError) throw sdkError;
      return sdkResult;
    } };
  }
}
Object.assign(FakeOpenAI, {
  APIError: OpenAI.APIError, APIConnectionTimeoutError: OpenAI.APIConnectionTimeoutError,
});
const generator = load("../src/lib/ai/server/context-draft.ts", {
  "server-only": {}, openai: { default: FakeOpenAI },
  "../prompts/context-draft-v1.0": prompt, "../../constants/research-options": options,
  "../context-draft-contract": contract, "./config": config,
});
const service = load("../src/lib/ai/server/context-draft-service.ts", {
  "server-only": {}, "../context-draft-contract": contract, "./config": config,
  "../../images/limits": { IMAGE_BUCKET: "why-box-images" },
});
const sessionId = "20000000-0000-4000-8000-000000000001";
const requestId = "30000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000001";
const valid = { primary_category_id: "ux_ui", subcategory_id: "web_design",
  other_category_text: null, stage_id: "idea_concept", context_ids: ["visual_form"], additional_context: null };
const body = { session_id: sessionId, request_id: requestId, mode: "auto", input: valid };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const completed = (text) => ({ status: "completed", output: [
  { type: "message", status: "completed", content: [{ type: "output_text", text }] },
] });

function clientSetup(send) {
  let current = { input: { ...valid }, imageCount: 1, imageRevision: "image-1", editable: true };
  const states = [], calls = [], applied = [];
  const controller = new ContextDraftController(sessionId, () => current,
    (text) => { applied.push(text); current = { ...current, input: { ...current.input, additional_context: text } }; },
    (state) => states.push(state), async (request, signal) => {
      calls.push({ request, signal });
      return send ? send(request, signal) : { request_id: request.request_id, draft_text: "AI 초안" };
    });
  controller.attach();
  return { controller, states, calls, applied, get current() { return current; },
    update(patch) { current = { ...current, ...patch }; } };
}

test("request validates required stable IDs and refuses client model, labels, prompt or image URLs", () => {
  assert.equal(contract.draftRequestSchema.safeParse(body).success, true);
  for (const patch of [
    { primary_category_id: null }, { subcategory_id: "graphic_design" }, { stage_id: null },
    { context_ids: [] }, { context_ids: ["visual_form", "visual_form"] },
    { context_ids: options.REFLECTION_CONTEXTS.slice(0, 4).map((x) => x.id) },
    { context_ids: ["unknown"] }, { primary_category_id: "others", subcategory_id: "other" },
  ]) assert.equal(contract.draftRequestSchema.safeParse({ ...body, input: { ...valid, ...patch } }).success, false);
  for (const key of ["prompt", "model", "image_url", "label"]) {
    assert.equal(contract.draftRequestSchema.safeParse({ ...body, [key]: "injected" }).success, false);
  }
});

test("automatic generation happens once across Strict Mode attach/detach, step round trips, edits and deletion", async () => {
  const s = clientSetup();
  s.controller.automatic(false);
  assert.equal(s.calls.length, 0);
  s.controller.automatic(true);
  s.controller.detach();
  s.controller.attach();
  s.controller.automatic(true);
  await settle();
  assert.deepEqual(s.applied, ["AI 초안"]);
  s.update({ input: { ...valid, stage_id: "structure_design" } });
  s.controller.userEdited();
  s.controller.automatic(false);
  s.controller.automatic(true);
  assert.equal(s.calls.length, 1);
});

test("incomplete, read-only and existing participant text never trigger automatic generation", async () => {
  for (const patch of [{ imageCount: null }, { imageCount: 0 }, { imageCount: 11 }, { editable: false },
    { input: { ...valid, stage_id: null } }, { input: { ...valid, additional_context: "직접 쓴 글" } }]) {
    const s = clientSetup(); s.update(patch); s.controller.automatic(true);
    await settle(); assert.equal(s.calls.length, 0);
  }
});

test("auto failure consumes local opportunity; manual retry remains available and old text is retained", async () => {
  let failing = true;
  const s = clientSetup((request) => {
    if (failing) throw new contract.DraftError("DRAFT-TIMEOUT");
    return { request_id: request.request_id, draft_text: "수동 초안" };
  });
  s.controller.automatic(true); await settle();
  assert.equal(s.states.at(-1).status, "error");
  s.controller.automatic(false); s.controller.automatic(true);
  assert.equal(s.calls.length, 1);
  failing = false;
  await s.controller.generate("manual");
  assert.deepEqual(s.applied, ["수동 초안"]);
});

test("persisted claim mock skips generation after refresh/reconnect and after deletion", async () => {
  const send = (request) => ({ request_id: request.request_id, skipped: true });
  for (let reconnect = 0; reconnect < 2; reconnect++) {
    const s = clientSetup(send); s.controller.automatic(true); await settle();
    assert.deepEqual(s.applied, []);
    assert.equal(s.states.at(-1).status, "idle");
  }
});

test("manual edit and edit-then-revert invalidate pending result", async () => {
  for (const revert of [false, true]) {
    let resolve;
    const s = clientSetup((request) => new Promise((done) => {
      resolve = () => done({ request_id: request.request_id, draft_text: "늦은 응답" });
    }));
    s.controller.automatic(true);
    s.controller.userEdited();
    s.update({ input: { ...valid, additional_context: revert ? null : "사용자 글" } });
    if (revert) s.controller.userEdited();
    resolve(); await settle();
    assert.deepEqual(s.applied, []);
    assert.equal(s.states.at(-1).message, contract.draftErrorMessages["DRAFT-EDITED"]);
  }
});

test("A/B response reversal, wrong response request ID and unmount never apply stale output", async () => {
  const pending = [];
  const s = clientSetup((request) => new Promise((resolve) => pending.push({ request, resolve })));
  const a = s.controller.generate("manual"), b = s.controller.generate("manual");
  assert.equal(s.calls[0].signal.aborted, true);
  pending[1].resolve({ request_id: pending[1].request.request_id, draft_text: "B" }); await b;
  pending[0].resolve({ request_id: pending[0].request.request_id, draft_text: "A" }); await a;
  assert.deepEqual(s.applied, ["B"]);
  const wrong = clientSetup(() => ({ request_id: requestId, draft_text: "wrong" }));
  await wrong.controller.generate("manual");
  assert.equal(wrong.states.at(-1).message, contract.draftErrorMessages["DRAFT-STALE"]);
  let done;
  const gone = clientSetup((request) => new Promise((resolve) => { done = () => resolve({
    request_id: request.request_id, draft_text: "gone",
  }); }));
  gone.controller.automatic(true); gone.controller.detach(); await settle(); done(); await settle();
  assert.equal(gone.calls[0].signal.aborted, true); assert.deepEqual(gone.applied, []);
});

test("input snapshot, image ordering or editability changes discard results without automatic retry", async () => {
  for (const patch of [
    { input: { ...valid, stage_id: "structure_design" } },
    { input: { ...valid, context_ids: ["next_steps"] } },
    { imageRevision: "image-2" }, { editable: false },
  ]) {
    let resolve;
    const s = clientSetup((request) => new Promise((done) => {
      resolve = () => done({ request_id: request.request_id, draft_text: "old" });
    }));
    s.controller.automatic(true); s.update(patch); resolve(); await settle();
    assert.deepEqual(s.applied, []);
    s.controller.automatic(true);
    assert.equal(s.calls.length, 1);
    assert.equal(s.states.at(-1).message, contract.draftErrorMessages["DRAFT-STALE"]);
  }
});

test("upstream inputs changed and reverted still discard pending response", async () => {
  let resolve;
  const s = clientSetup((request) => new Promise((done) => {
    resolve = () => done({ request_id: request.request_id, draft_text: "old" });
  }));
  s.controller.automatic(true); s.controller.inputsChanged(); s.controller.inputsChanged();
  resolve(); await settle();
  assert.deepEqual(s.applied, []);
  assert.equal(s.states.at(-1).message, contract.draftErrorMessages["DRAFT-STALE"]);
});

test("frozen prompt is unmodified and exact Responses parameters preserve 1/10 image order and labels", () => {
  const source = readFileSync(new URL("../src/lib/ai/prompts/context-draft-v1.0.ts", import.meta.url));
  assert.equal(createHash("sha256").update(source).digest("hex"),
    "fcc2f23abc35becaf02a520cd2768cbb35c0ed6809a9af143dd8e3451a82d8be");
  for (const count of [1, 10]) {
    const urls = Array.from({ length: count }, (_, i) => `https://signed.invalid/${i}`);
    const params = generator.draftParameters("configured-id", { ...valid, additional_context: "not sent" }, urls);
    assert.equal(params.instructions, prompt.CONTEXT_DRAFT_PROMPT);
    assert.equal(params.model, "configured-id"); assert.equal(params.store, false); assert.equal(params.stream, false);
    assert.deepEqual(params.input[0].content.filter((x) => x.type === "input_image").map((x) => x.image_url), urls);
    assert.match(params.input[0].content[0].text, /웹 디자인/);
    assert.doesNotMatch(params.input[0].content[0].text, /not sent/);
  }
});

test("plain-text completion validates trim, Unicode 1000, refusal, interruption, empty and overflow", () => {
  assert.equal(generator.extractDraft(completed("  제 작업입니다.  ")), "제 작업입니다.");
  assert.equal(generator.extractDraft(completed("😀".repeat(1000))).length, 2000);
  const checks = [
    [completed(" "), "DRAFT-EMPTY"], [completed("가".repeat(1001)), "DRAFT-LENGTH"],
    [{ ...completed("partial"), status: "incomplete" }, "DRAFT-INCOMPLETE"],
    [{ status: "completed", output: [{ type: "message", status: "incomplete", content: [] }] }, "DRAFT-INCOMPLETE"],
    [{ status: "completed", output: [{ type: "message", content: [{ type: "refusal" }] }] }, "DRAFT-REFUSAL"],
  ];
  for (const [response, code] of checks) assert.throws(() => generator.extractDraft(response), { code });
});

test("SDK mock uses no retries, timeout, abort signal; classifies 429, API and timeout safely", async () => {
  sdkCalls = []; sdkError = null; sdkResult = completed("최종 초안");
  const signal = new AbortController().signal;
  assert.equal(await generator.generateContextDraft({ apiKey: "mock-only", model: "configured-id" }, valid, ["https://signed.invalid/1"], signal), "최종 초안");
  assert.equal(sdkCalls[0].settings.maxRetries, 0);
  assert.equal(sdkCalls[0].settings.timeout, 60000);
  assert.equal(sdkCalls[0].settings.logLevel, "off");
  assert.equal(sdkCalls[0].requestOptions.signal, signal);
  for (const [error, code] of [
    [new OpenAI.APIConnectionTimeoutError(), "DRAFT-TIMEOUT"],
    [new OpenAI.APIError(429, {}, "sensitive URL", new Headers()), "DRAFT-RATE"],
    [new OpenAI.APIError(500, {}, "sensitive URL", new Headers()), "DRAFT-API"],
    [new OpenAI.APIError(400, {}, "image URL invalid", new Headers()), "DRAFT-API"],
    [new OpenAI.APIError(404, {}, "sensitive URL", new Headers()), "DRAFT-CONFIG"],
  ]) {
    sdkError = error;
    await assert.rejects(generator.generateContextDraft({ apiKey: "mock-only", model: "configured-id" }, valid, ["https://signed.invalid/1"], signal), { code });
  }
  sdkError = null;
});

test("AI settings are lazily validated, default disabled, and never guess a model ID", () => {
  for (const env of [{}, { OPENAI_CONTEXT_DRAFT_ENABLED: "true" },
    { OPENAI_CONTEXT_DRAFT_ENABLED: "true", OPENAI_API_KEY: "mock-only" },
    { OPENAI_API_KEY: "mock-only", OPENAI_CONTEXT_DRAFT_MODEL: "configured-id" }]) {
    assert.throws(() => config.contextDraftConfig(env), { code: "DRAFT-CONFIG" });
  }
  assert.deepEqual(config.contextDraftConfig({ OPENAI_CONTEXT_DRAFT_ENABLED: "true",
    OPENAI_API_KEY: "mock-only", OPENAI_CONTEXT_DRAFT_MODEL: "configured-id" }),
  { apiKey: "mock-only", model: "configured-id" });
});

function supabaseMock(patch = {}) {
  const calls = { queries: [], signed: [], claims: [] };
  const images = Array.from({ length: patch.count ?? 1 }, (_, i) => ({
    id: `image-${i}`, storage_path: `${userId}/${sessionId}/${i}.png`, sort_order: i * 2,
  }));
  const client = {
    auth: { getUser: async () => ({ data: { user: patch.anonymous ? null : { id: userId } }, error: patch.authError ?? null }) },
    from(table) {
      const chain = {
        select(...args) { calls.queries.push([table, "select", ...args]); return chain; },
        eq(...args) { calls.queries.push([table, "eq", ...args]); return chain; },
        order(...args) { calls.queries.push([table, "order", ...args]); return chain; },
        maybeSingle() { return chain; },
        then(resolve, reject) {
          let result;
          if (table === "profiles") result = { data: { role: patch.role ?? "participant", status: patch.profileStatus ?? "active" }, error: patch.profileError ?? null };
          if (table === "sessions") result = { data: patch.missing ? null : { status: patch.status ?? "draft", additional_context: patch.text ?? null }, error: patch.sessionError ?? null };
          if (table === "questions") result = { count: patch.questions ?? 0, error: patch.questionError ?? null };
          if (table === "session_images") result = { data: patch.images ?? images, error: patch.imageError ?? null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    },
    rpc: async (...args) => { calls.claims.push(args); return patch.claim ?
      patch.claim(...args) : { data: patch.claimed ?? true, error: patch.claimError ?? null }; },
    storage: { from(bucket) {
      assert.equal(bucket, "why-box-images");
      return { createSignedUrl: async (path, expiry) => {
        calls.signed.push({ path, expiry });
        if (patch.signFailure === calls.signed.length) return { data: null, error: new Error("private storage path") };
        return { data: { signedUrl: `https://signed.invalid/${images.findIndex((x) => x.storage_path === path)}` }, error: null };
      } };
    } },
  };
  return { client, calls };
}

test("RLS client signs all 1/10 server-queried registered images in sort order; no browser URLs", async () => {
  for (const count of [1, 10]) {
    const s = supabaseMock({ count });
    const urls = await service.prepareDraft(s.client, userId, body);
    assert.equal(urls.length, count);
    assert.deepEqual(s.calls.queries.find((x) => x[0] === "session_images" && x[1] === "order"),
      ["session_images", "order", "sort_order", { ascending: true }]);
    assert.deepEqual(urls, Array.from({ length: count }, (_, i) => `https://signed.invalid/${i}`));
    assert.ok(s.calls.signed.every((x) => x.expiry === 180));
    assert.equal(s.calls.claims[0][0], "claim_context_draft");
    assert.equal(s.calls.claims[0][1].p_manual, false);
    assert.equal(Object.hasOwn(s.calls.claims[0][1], "p_additional_context"), false);
  }
});

test("image preparation failures reject whole request; claims are not reset", async () => {
  for (const [patch, code] of [
    [{ count: 0 }, "DRAFT-INPUT"], [{ count: 11 }, "DRAFT-INPUT"],
    [{ count: 10, signFailure: 5 }, "DRAFT-IMAGE"],
    [{ imageError: {} }, "DRAFT-IMAGE"],
    [{ images: [{ storage_path: "other/session/private.png" }] }, "DRAFT-IMAGE"],
    [{ claimError: { code: "PGRST202" } }, "DRAFT-DB"],
    [{ claimError: { code: "42501" } }, "DRAFT-AUTH"],
    [{ claimError: { code: "22023" } }, "DRAFT-INPUT"],
  ]) {
    const s = supabaseMock(patch);
    await assert.rejects(service.prepareDraft(s.client, userId, body), { code });
    assert.ok(s.calls.claims.length <= 1);
  }
});

test("mock atomic claim permits one auto attempt across two tabs, then manual requests without resetting", async () => {
  let marker = null;
  const claim = async (_name, args) => {
    if (!args.p_manual && marker) return { data: false, error: null };
    marker ??= "claimed";
    return { data: true, error: null };
  };
  const a = supabaseMock({ claim }), b = supabaseMock({ claim });
  const results = await Promise.all([service.prepareDraft(a.client, userId, body), service.prepareDraft(b.client, userId, body)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await service.prepareDraft(a.client, userId, body), null);
  assert.equal((await service.prepareDraft(b.client, userId, { ...body, mode: "manual" })).length, 1);
  assert.equal(marker, "claimed");
});

test("SQL migration locks owned session before claim, validates exact IDs and protects immutable timestamp", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261005231000_context_draft_claim.sql", import.meta.url), "utf8");
  assert.match(sql, /^begin;/); assert.match(sql, /commit;\s*$/);
  assert.match(sql, /add column context_draft_auto_claimed_at timestamptz;/);
  assert.match(sql, /security invoker/); assert.doesNotMatch(sql, /security definer|create table|create policy|alter policy|drop policy|storage\./i);
  assert.match(sql, /s\.participant_id = auth\.uid\(\)\s+for update;/);
  assert.ok(sql.indexOf("for update;") < sql.indexOf("if not p_manual"));
  assert.match(sql, /old\.context_draft_auto_claimed_at is not null/);
  assert.match(sql, /Draft claim cannot be reset or changed/);
  assert.match(sql, /new\.context_draft_auto_claimed_at := clock_timestamp\(\)/);
  assert.match(sql, /public\.can_edit_session_context\(old\.id\)/);
  assert.match(sql, /from public\.questions/); assert.match(sql, /image_count not between 1 and 10/);
  assert.match(sql, /session_row\.additional_context/);
  assert.match(sql, /grant execute[\s\S]*to authenticated;/);
  assert.doesNotMatch(sql, /delete from|save_session_context|additional_context\s*=/);
  const categories = JSON.parse(sql.match(/category_options constant jsonb := '([\s\S]*?)';/)[1]);
  assert.deepEqual(categories, Object.fromEntries(options.DESIGN_CATEGORIES.map((c) => [c.id, c.items.map((s) => s.id)])));
  for (const item of [...options.WORK_STAGES, ...options.REFLECTION_CONTEXTS]) assert.ok(sql.includes(`'${item.id}'`));
});

function routeSetup(patch = {}) {
  const s = supabaseMock(patch);
  const calls = { ...s.calls, generated: [] };
  const authErrors = load("../src/lib/auth/session-error.ts");
  const route = load("../src/app/api/context-draft/route.ts", {
    "@/lib/supabase/server": { createSupabaseServerClient: async () => s.client },
    "@/lib/auth/session-error": authErrors, "@/lib/ai/context-draft-contract": contract,
    "@/lib/ai/server/config": { ...config, contextDraftConfig: () => {
      if (patch.configError) throw new contract.DraftError("DRAFT-CONFIG", 503);
      return { apiKey: "mock-only", model: "configured-id" };
    } },
    "@/lib/ai/server/context-draft-service": service,
    "@/lib/ai/server/context-draft": { generateContextDraft: async (...args) => {
      calls.generated.push(args);
      if (patch.generateError) throw patch.generateError;
      if (patch.afterGenerate) patch.afterGenerate(patch);
      return patch.pendingGeneration ? new Promise(() => {}) : "검증된 초안";
    } },
  });
  const { NextRequest } = require("next/server");
  const request = (value = body, origin = "http://localhost:3000") => new NextRequest("http://localhost:3000/api/context-draft", {
    method: "POST", headers: { origin, host: "localhost:3000", "Content-Type": "application/json" },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  return { ...s, calls, post: (value, origin) => route.POST(request(value, origin)) };
}

test("API returns only request ID and draft, no signed URL, prompt, key or internal config", async () => {
  const s = routeSetup();
  const response = await s.post();
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { request_id: requestId, draft_text: "검증된 초안" });
  assert.equal(s.calls.generated.length, 1);
  assert.equal(s.calls.claims.length, 1);
  assert.deepEqual(s.calls.generated[0][1], valid);
});

test("API rejects origin, malformed/oversized input, inactive/Admin/anonymous/foreign/frozen sessions before generation", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  for (const patch of [{ anonymous: true }, { role: "admin" }, { profileStatus: "deactivated" },
    { missing: true }, { status: "completed" }, { questions: 1 }, { questionError: {} },
    { configError: true }, { claimError: { code: "PGRST202" } }]) {
    const s = routeSetup(patch); const response = await s.post();
    assert.ok(response.status >= 400);
    assert.equal(s.calls.generated.length, 0);
  }
  for (const [value, origin] of [[body, "https://evil.invalid"], ["not-json"], ["x".repeat(16385)],
    [{ ...body, model: "injected" }]]) {
    const s = routeSetup(); const response = await s.post(value, origin);
    assert.ok(response.status >= 400); assert.equal(s.calls.generated.length, 0);
  }
  assert.ok(logs.length > 0);
  assert.doesNotMatch(JSON.stringify(logs), /mock-only|signed\.invalid|웹 디자인|private\.png/);
});

test("API skipped marker never calls OpenAI; generated response is rejected if questions appear in flight", async (t) => {
  t.mock.method(console, "error", () => {});
  const skipped = routeSetup({ claimed: false });
  assert.deepEqual(await (await skipped.post()).json(), { request_id: requestId, skipped: true });
  assert.equal(skipped.calls.generated.length, 0);
  const patch = { afterGenerate: (state) => { state.questions = 1; } };
  const s = routeSetup(patch);
  assert.equal((await s.post()).status, 403);
});

test("API errors preserve safe classifications and do not reset successful claims or write textarea", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const [code, status] of [["DRAFT-TIMEOUT", 504], ["DRAFT-RATE", 429],
    ["DRAFT-API", 502], ["DRAFT-REFUSAL", 502], ["DRAFT-EMPTY", 502], ["DRAFT-LENGTH", 502]]) {
    const s = routeSetup({ generateError: new contract.DraftError(code, status) });
    const response = await s.post();
    assert.equal(response.status, status);
    assert.equal((await response.json()).errorCode, code);
    assert.equal(s.calls.claims.length, 1);
    assert.ok(s.calls.queries.every((x) => !["update", "insert"].includes(x[1])));
    if (status === 429) assert.equal(response.headers.get("Retry-After"), "60");
  }
});

test("API overall deadline times out even if mocked provider never resolves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const s = routeSetup({ pendingGeneration: true });
  const pending = s.post();
  // Request body stream scheduling precedes the mock provider call.
  for (let i = 0; i < 100 && !s.calls.generated.length; i++) await settle();
  assert.equal(s.calls.generated.length, 1);
  t.mock.timers.tick(60000);
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal((await response.json()).errorCode, "DRAFT-TIMEOUT");
  assert.equal(s.calls.generated[0][3].aborted, true);
});

test("client transport rejects invalid success body, preserves error codes, sends abort signal", async (t) => {
  let sent;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    sent = options;
    return Response.json({ request_id: requestId, draft_text: "초안" });
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await requestContextDraft(body, signal), { request_id: requestId, draft_text: "초안" });
  assert.equal(sent.signal, signal);
  t.mock.method(globalThis, "fetch", async () => Response.json({ draft_text: "missing id" }));
  await assert.rejects(requestContextDraft(body, signal), { code: "DRAFT-API" });
  t.mock.method(globalThis, "fetch", async () => Response.json({ errorCode: "DRAFT-RATE" }, { status: 429 }));
  await assert.rejects(requestContextDraft(body, signal), { code: "DRAFT-RATE" });
});

test("AI draft enters existing serialized autosave; later save failure retains final textarea input", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = [], states = [];
  const saver = new ContextAutosave(valid, async (value) => {
    saved.push(value); return { success: false, message: "mock save failure" };
  }, (state) => states.push(state));
  let latest = { ...valid };
  const controller = new ContextDraftController(sessionId,
    () => ({ input: latest, editable: true, imageCount: 1, imageRevision: "1" }),
    (text) => { latest = { ...latest, additional_context: text }; saver.change(latest, 1000); },
    () => {}, async (request) => ({ request_id: request.request_id, draft_text: "최종 AI 글" }));
  controller.attach(); controller.automatic(true); await settle();
  assert.equal(saved.length, 0); assert.equal(latest.additional_context, "최종 AI 글");
  t.mock.timers.tick(1000); await settle();
  assert.equal(saved.length, 1); assert.equal(states.at(-1).status, "저장 실패");
  assert.equal(latest.additional_context, "최종 AI 글"); assert.equal(saver.dirty, true);
  saver.dispose();
});

test("actual final-step form confirms replacement, keeps old text while generating, and uses existing autosave", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  t.after(() => { globalThis.window = oldWindow; globalThis.document = oldDocument; });
  const slots = [], effects = [], cleanups = [], saves = [], requests = [];
  let cursor = 0, initialRender = true, resolve;
  const hooks = {
    useState(value) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = value;
      return [slots[index], (next) => { slots[index] = next; }];
    },
    useRef(value) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: value };
      return slots[index];
    },
    useEffect(effect) { if (initialRender) effects.push(effect); },
  };
  class TestController extends ContextDraftController {
    constructor(...args) {
      super(...args, (request) => {
        requests.push(request);
        return new Promise((done) => { resolve = () => done({ request_id: request.request_id, draft_text: "새 AI 초안" }); });
      });
    }
  }
  const { SessionContextForm } = load("../src/app/(participant)/sessions/[sessionId]/session-context-form.tsx", {
    react: hooks, "@/lib/constants/research-options": options,
    "@/lib/session-context/input": inputModule, "@/lib/ai/context-draft-contract": contract,
    "@/lib/session-context/autosave": { ContextAutosave },
    "@/lib/session-context/context-draft-controller": { ContextDraftController: TestController },
    "./context-actions": { saveSessionContext: async (_id, value) => {
      saves.push(value); return { success: false, message: "TEST save failed" };
    } },
  });
  const initial = { ...valid, additional_context: "기존 글" };
  function render() {
    cursor = 0;
    const nodes = [];
    function visit(element) {
      if (Array.isArray(element)) return element.forEach(visit);
      if (!element || typeof element !== "object") return;
      nodes.push(element); visit(element.props?.children);
    }
    visit(SessionContextForm({ sessionId, editable: true, activeStep: 3, imageCount: 1,
      imageRevision: "image1", initial }));
    return nodes;
  }
  const button = (nodes) => nodes.find((n) => n.type === "button" && n.props.children === "AI로 다시 작성 ↻");
  const helpText = (nodes) => nodes.find((n) => n.props?.id === "context-help").props.children.find((n) => n.type === "span").props.children;
  let nodes = render();
  initialRender = false;
  for (const effect of effects) cleanups.push(effect());
  assert.equal(requests.length, 0);
  button(nodes).props.onClick();
  assert.equal(requests.length, 0);
  nodes = render();
  let confirmation = nodes.find((n) => n.props?.action);
  assert.match(confirmation.props.message, /교체하시겠어요/);
  confirmation.props.action.props.children[0].props.onClick();
  button(render()).props.onClick();
  confirmation = render().find((n) => n.props?.action);
  confirmation.props.action.props.children[1].props.onClick();
  nodes = render();
  assert.equal(button(nodes).props.disabled, true);
  assert.match(helpText(nodes), /AI가 작업 맥락을 정리하고 있어요/);
  assert.equal(nodes.find((n) => n.props?.id === "context-help").props.role, "status");
  assert.ok(!nodes.some((n) => n.props?.className === "supporting-copy"));
  assert.equal(nodes.find((n) => n.props?.id === "additional-context").props.value, "기존 글");
  assert.equal(requests[0].mode, "manual");
  resolve(); await settle();
  nodes = render();
  assert.equal(nodes.find((n) => n.props?.id === "additional-context").props.value, "새 AI 초안");
  assert.match(helpText(nodes), /작업 맥락을 정리했어요/);
  assert.ok(!nodes.some((n) => n.props?.className === "supporting-copy"));
  assert.equal(saves.length, 0);
  t.mock.timers.tick(1000); await settle();
  assert.equal(saves.length, 1); assert.equal(saves[0].additional_context, "새 AI 초안");
  nodes = render();
  assert.equal(nodes.find((n) => n.props?.id === "additional-context").props.value, "새 AI 초안");
  assert.ok(nodes.some((n) => n.props?.children === "저장 실패"));
  for (const cleanup of cleanups) cleanup?.();
  await settle();
});
