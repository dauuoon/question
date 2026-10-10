import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import process from "node:process";
import { researcherRefinementEnvironment, prepareResearcherRefinementSnapshot, testRuntimeEnvironment, TEST_REF } from "../scripts/test-runtime.mjs";

const require = createRequire(import.meta.url);
class RefinementError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
function load() {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync("scripts/test-runtime/researcher-refinement.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInThisContext(`(function(require,module,exports){${code}\n})`)(name =>
    name === "@/lib/ai/sentence-refinement-contract" ? { SentenceRefinementError: RefinementError } : require(name),
  module, module.exports);
  return module.exports;
}
const fixture = { projectRef: TEST_REF, purpose: "researcher-synthetic-sentence-refinement",
  stage: "ready", callLimit: 3, participantId: "10000000-0000-4000-8000-000000000001",
  sessionId: "20000000-0000-4000-8000-000000000001" };
const config = { SUPABASE_TEST_URL: `https://${TEST_REF}.supabase.co`,
  SUPABASE_TEST_PUBLISHABLE_KEY: "sb_publishable_fixture",
  SUPABASE_TEST_SERVICE_ROLE_KEY: "sb_secret_fixture" };
const base = testRuntimeEnvironment(config, {});
const local = { OPENAI_API_KEY: "mock-key-never-sent", OPENAI_SENTENCE_REFINEMENT_MODEL: "gpt-6-astra" };

test("researcher environment is disabled by default, scopes approval and rejects Production/invalid fixtures", () => {
  assert.deepEqual(researcherRefinementEnvironment(base, fixture, local, "/budget", "prompt"), base);
  const env = researcherRefinementEnvironment(base, fixture, local, "/budget", "prompt", true);
  assert.equal(env.WHY_BOX_RESEARCHER_SESSION, fixture.sessionId);
  assert.equal(env.OPENAI_CONTEXT_DRAFT_ENABLED, "false");
  assert.equal(env.OPENAI_QUESTION_GENERATION_MODEL, "");
  assert.equal(env.OPENAI_QUESTION_REGENERATION_ENABLED, "false");
  assert.equal(env.SESSION_BRIEFING_MOCK_ENABLED, "true");
  for (const invalid of [{ ...fixture, projectRef: "production" }, { ...fixture, stage: "failed" },
    { ...fixture, callLimit: 4 }, { ...fixture, sessionId: null }]) {
    assert.throws(() => researcherRefinementEnvironment(base, invalid, local, "/budget", "prompt", true));
  }
  assert.throws(() => researcherRefinementEnvironment({ ...base, NODE_ENV: "production" }, fixture, local, "/budget", "prompt", true));
});

test("researcher guard enforces identity, arbitrary bounded text and durable total three calls across reloads", async () => {
  const folder = mkdtempSync(join(tmpdir(), "whybox-researcher-budget-"));
  const oldEnv = { ...process.env }, oldFetch = globalThis.fetch;
  const prompt = "mock prompt";
  Object.assign(process.env, researcherRefinementEnvironment(base, fixture, local, folder, prompt, true));
  writeFileSync(join(folder, "policy.json"), JSON.stringify(fixture));
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Mock timeout; no network"); };
  try {
    const guard = load();
    assert.doesNotThrow(() => guard.assertResearcherScope(fixture.participantId, fixture.sessionId));
    assert.throws(() => guard.assertResearcherScope("other", fixture.sessionId), { code: "REFINE-AUTH" });
    assert.throws(() => guard.assertResearcherScope(fixture.participantId, "other"), { code: "REFINE-AUTH" });
    for (const [key, value] of [["NODE_ENV", "production"], ["NEXT_PUBLIC_SUPABASE_URL", "https://production.supabase.co"],
      ["WHY_BOX_RESEARCHER_REFINEMENT", ""], ["OPENAI_QUESTION_GENERATION_MODEL", "enabled"],
      ["OPENAI_QUESTION_REGENERATION_ENABLED", "true"], ["OPENAI_CONTEXT_DRAFT_ENABLED", "true"]]) {
      const previous = process.env[key]; process.env[key] = value;
      assert.throws(() => guard.assertResearcherScope(fixture.participantId, fixture.sessionId), { code: "REFINE-CONFIG" });
      process.env[key] = previous;
    }
    const body = { model: "gpt-6-astra", store: false, stream: false, max_output_tokens: 800,
      instructions: prompt, input: [{ role: "user", content: [{ type: "input_text", text: "새로운 자유 입력 답변" }] }] };
    const request = payload => ({ method: "POST", body: JSON.stringify(payload) });
    const url = "https://api.openai.com/v1/responses";
    for (const invalid of [{ ...body, max_output_tokens: 4000 }, { ...body, store: true },
      { ...body, instructions: "tampered" }, { ...body, model: "other" },
      { ...body, input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(1201) }] }] }]) {
      await assert.rejects(guard.researcherRefinementFetch(url, request(invalid)), { code: "REFINE-INPUT" });
    }
    assert.equal(calls, 0);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => guard.researcherRefinementFetch(url, request(body))));
    assert.equal(results.filter(r => r.reason?.code === "REFINE-BUDGET").length, 5);
    assert.equal(calls, 3);
    assert.equal(load().researcherRefinementRemaining(folder), 0);
    await assert.rejects(load().researcherRefinementFetch(url, request(body)), { code: "REFINE-BUDGET" });
    assert.equal(calls, 3);
    for (let i = 1; i <= 3; i++) {
      assert.equal(JSON.parse(readFileSync(join(folder, `call-${i}.result.json`))).status, "failed_or_timeout");
    }
    assert.equal(process.env.WHY_BOX_TEST_PROMPT_HASH, createHash("sha256").update(prompt).digest("hex"));
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(oldEnv, key)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    rmSync(folder, { recursive: true });
  }
});

test("generated researcher route checks authenticated account and session before provider, retains original and CAS", async () => {
  const folder = mkdtempSync(join(tmpdir(), "whybox-researcher-snapshot-"));
  for (const file of ["src/lib/ai/server/sentence-refinement.ts", "src/app/api/sentence-refinement/route.ts"]) {
    mkdirSync(join(folder, file, ".."), { recursive: true });
    cpSync(file, join(folder, file));
  }
  prepareResearcherRefinementSnapshot(folder);
  let userId = fixture.participantId, sessionId = fixture.sessionId, providerCalls = 0;
  const writes = [];
  const revision = "2026-10-10T12:00:00.123456+00:00";
  const questionId = "30000000-0000-4000-8000-000000000001";
  const cache = new Map();
  function resolveModule(file) {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInThisContext(`(function(require,module,exports){${code}\n})`)(name => {
      if (name === "server-only") return {};
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name.startsWith("@/")) return resolveModule(`src/${name.slice(2)}.ts`);
      if (name.startsWith(".")) return resolveModule(join(file, "..", `${name}.ts`));
      return require(name);
    }, module, module.exports);
    cache.set(file, module.exports);
    return module.exports;
  }
  const overrides = {};
  const contract = resolveModule("src/lib/ai/sentence-refinement-contract.ts");
  class AnswerError extends Error {}
  const query = {
    update(value) { writes.push(value); return query; },
    eq() { return query; }, abortSignal() { return query; }, select() { return query; },
    async maybeSingle() { return { data: { updated_at: revision }, error: null }; },
  };
  Object.assign(overrides, {
    "@/lib/supabase/server": { createSupabaseServerClient: async () => ({ from: () => query }) },
    "@/lib/activity/record": { recordParticipantActivity: async () => true },
    "@/lib/answers/server": {
      AnswerError, requireActiveParticipant: async () => userId,
      requireEditableQuestion: async () => ({ session_id: sessionId }),
      readAnswer: async () => ({ question_id: questionId, original_answer: "자유롭게 입력한 원문",
        refined_answer: null, current_answer_version: "original", updated_at: revision }),
    },
    "@/lib/ai/server/researcher-refinement": { assertResearcherScope(user, session) {
      if (user !== fixture.participantId || session !== fixture.sessionId) {
        throw new contract.SentenceRefinementError("REFINE-AUTH", 403);
      }
    } },
    "@/lib/ai/server/sentence-refinement-config": {
      sentenceRefinementConfig: () => local, SENTENCE_REFINEMENT_TIMEOUT_MS: 60000,
    },
    "@/lib/ai/server/sentence-refinement": { refineSentence: async () => {
      providerCalls++; return "정제한 결과";
    } },
    "@/lib/ai/server/sentence-refinement-flight": { runSentenceRefinement: async (_u, _q, _r, fn) => fn() },
  });

  test("success and HTTP failure both consume budget; invalid policy and aborted requests never dispatch", async () => {
    const folder = mkdtempSync(join(tmpdir(), "whybox-researcher-outcomes-"));
    const oldEnv = { ...process.env }, oldFetch = globalThis.fetch;
    Object.assign(process.env, researcherRefinementEnvironment(base, fixture, local, folder, "prompt", true));
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new globalThis.Response("{}", { status: calls === 1 ? 200 : 500 }); };
    const url = "https://api.openai.com/v1/responses";
    const body = JSON.stringify({ model: "gpt-6-astra", store: false, stream: false,
      max_output_tokens: 800, instructions: "prompt",
      input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(1200) }] }] });
    try {
      const guard = load();
      writeFileSync(join(folder, "policy.json"), JSON.stringify({ ...fixture, callLimit: 4 }));
      await assert.rejects(guard.researcherRefinementFetch(url, { method: "POST", body }), { code: "REFINE-CONFIG" });
      assert.equal(calls, 0);
      writeFileSync(join(folder, "policy.json"), JSON.stringify(fixture));
      const controller = new globalThis.AbortController(); controller.abort();
      await assert.rejects(guard.researcherRefinementFetch(url, {
        method: "POST", body, signal: controller.signal,
      }), { code: "REFINE-TIMEOUT" });
      assert.equal(guard.researcherRefinementRemaining(folder), 3);
      assert.equal((await guard.researcherRefinementFetch(url, { method: "POST", body })).status, 200);
      assert.equal((await guard.researcherRefinementFetch(url, { method: "POST", body })).status, 500);
      assert.equal(guard.researcherRefinementRemaining(folder), 1);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = oldFetch;
      for (const key of Object.keys(process.env)) if (!Object.hasOwn(oldEnv, key)) delete process.env[key];
      Object.assign(process.env, oldEnv);
      rmSync(folder, { recursive: true });
    }
  });
  try {
    const { POST } = resolveModule(join(folder, "src/app/api/sentence-refinement/route.ts"));
    const request = () => new (require("next/server").NextRequest)("http://localhost:3001/api/sentence-refinement", {
      method: "POST", headers: { origin: "http://localhost:3001", host: "localhost:3001" },
      body: JSON.stringify({ question_id: questionId, expected_updated_at: revision }),
    });
    userId = "other";
    assert.equal((await POST(request())).status, 403);
    userId = fixture.participantId; sessionId = "other";
    assert.equal((await POST(request())).status, 403);
    assert.equal(providerCalls, 0);
    assert.equal(writes.length, 0);
    sessionId = fixture.sessionId;
    assert.equal((await POST(request())).status, 200);
    assert.equal(providerCalls, 1);
    assert.equal(writes[0].refined_answer, "정제한 결과");
    assert.equal(Object.hasOwn(writes[0], "original_answer"), false);
    const service = readFileSync(join(folder, "src/lib/ai/server/sentence-refinement.ts"), "utf8");
    assert.match(service, /max_output_tokens:800/);
    assert.match(service, /maxRetries:0/);
    assert.match(service, /fetch:researcherRefinementFetch/);
  } finally { rmSync(folder, { recursive: true }); }
});
