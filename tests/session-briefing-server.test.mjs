import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative } from "node:path";
import { setImmediate } from "node:timers";
import { runInThisContext } from "node:vm";
import { fileURLToPath, URL } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path, mocks = {}) {
  const sourcePath = path.endsWith(".ts") ? path : `${path}.ts`;
  const url = new URL(`../${sourcePath}`, import.meta.url);
  const compiled = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} };
  runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
    name => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name === "server-only") return {};
      if (name.startsWith("@/")) return load(`src/${name.slice(2)}.ts`, mocks);
      if (name.startsWith(".")) return load(relative(fileURLToPath(new URL("../", import.meta.url)),
        fileURLToPath(new URL(name, url))), mocks);
      return require(name);
    }, module, module.exports);
  return module.exports;
}

const contract = load("src/lib/session-completion/briefing-contract.ts");
const { runSessionBriefing, SessionBriefingProviderError } =
  load("src/lib/ai/server/session-briefing-service.ts");
const { createMockSessionBriefingProvider, sessionBriefingMockEnabled } =
  load("src/lib/ai/server/session-briefing-provider.ts");
const { SESSION_DESIGN_BRIEFING_SCHEMA } =
  load("src/lib/ai/schemas/session-design-briefing-v1.0.ts");
const { createSessionBriefingRepository, SessionBriefingRepositoryError } =
  load("src/lib/session-completion/briefing-repository.ts");
const { hasSameOrigin, readJsonBody } = load("src/lib/session-completion/api.ts");
const sessionId = "20000000-0000-4000-8000-000000000001";
const requestId = "40000000-0000-4000-8000-000000000001";
const questionId = "50000000-0000-4000-8000-000000000001";
const snapshot = {
  session_id: sessionId,
  design_context: {
    primary_category_id: "ux_ui", subcategory_id: "web_design", other_category_text: null,
    stage_id: "idea_concept", additional_context: "TEST context",
  },
  context_ids: ["visual_form"],
  answered_questions: [{
    question_id: questionId, slot_index: 1, question_text: "What guided this choice?",
    answer: {
      original: "I wanted it to feel calm.", refined: "I wanted the interface to feel calm.",
      current_version: "refined", selected: "I wanted the interface to feel calm.",
    },
  }],
};
const generated = { briefing_text: "The design uses a calm interface to support focused decisions." };
const requestRecord = (overrides = {}) => ({
  accepted: true, request_id: requestId, state: "ready", attempt_number: 1,
  retry_of_request_id: null, missing_question_ids: [], has_answer: true,
  input_snapshot: snapshot, replayed: false, ...overrides,
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function repository() {
  const calls = { begin: 0, dispatch: 0, complete: [], fail: [], read: 0 };
  const rows = new Map();
  let attemptNumber = 0;
  return {
    calls,
    async begin(input) {
      calls.begin++;
      const existing = rows.get(input.request_id);
      if (existing) return existing;
      if (input.retry_of_request_id) {
        const prior = rows.get(input.retry_of_request_id);
        if (!prior || prior.state !== "failed" || attemptNumber !== 1) throw new Error("retry denied");
        attemptNumber = 2;
      } else {
        attemptNumber = 1;
      }
      const row = requestRecord({
        request_id: input.request_id, attempt_number: attemptNumber,
        retry_of_request_id: input.retry_of_request_id, replayed: false,
      });
      rows.set(input.request_id, row);
      return row;
    },
    async read(_session, id) {
      calls.read++;
      return rows.get(id);
    },
    async dispatch(_session, id) {
      calls.dispatch++;
      const row = rows.get(id);
      if (!row || row.state !== "ready") return false;
      row.state = "dispatch_started";
      return true;
    },
    async complete(input) {
      calls.complete.push(input);
      const row = rows.get(input.request_id);
      row.state = "completed";
      row.accepted = true;
      return { state: "completed" };
    },
    async fail(input) {
      calls.fail.push(input);
      const row = rows.get(input.request_id);
      row.state = input.outcome_unknown ? "dispatch_unknown" : "failed";
      row.accepted = false;
      return true;
    },
  };
}

test("briefing input and response contracts retain selected answer provenance and reject invalid payloads", () => {
  assert.equal(contract.briefingInputSchema.safeParse(snapshot).success, true);
  assert.equal(contract.briefingInputSchema.safeParse({
    ...snapshot, answered_questions: snapshot.answered_questions.map(q =>
      ({ ...q, answer: { ...q.answer, selected: "  " } })),
  }).success, false);
  assert.equal(contract.briefingInputSchema.safeParse({ ...snapshot, provider_key: "secret" }).success, false);
  assert.equal(contract.briefingResultSchema.safeParse(generated).success, true);
  assert.equal(contract.briefingResultSchema.safeParse({ ...generated, extra: true }).success, false);
  assert.equal(contract.briefingRequestSchema.safeParse(requestRecord()).success, true);
});

test("mock briefing provider is restricted to the explicit TEST project and never enriches supplied facts", async () => {
  const testEnv = {
    NODE_ENV: "development",
    SESSION_BRIEFING_MOCK_ENABLED: "true",
    NEXT_PUBLIC_SUPABASE_URL: "https://njtgxnlxlhxpbiekbgmv.supabase.co",
  };
  assert.equal(sessionBriefingMockEnabled(testEnv), true);
  assert.equal(sessionBriefingMockEnabled({ ...testEnv, NODE_ENV: "production" }), false);
  assert.equal(sessionBriefingMockEnabled({
    ...testEnv, NEXT_PUBLIC_SUPABASE_URL: "https://jaqyzbrvufknpsbcuqzw.supabase.co",
  }), false);
  const provider = createMockSessionBriefingProvider(testEnv);
  const result = await provider.generate(snapshot);
  assert.equal(result.model_id, "WHY-BOX-LOCAL-MOCK");
  assert.match(result.response.briefing_text, /제 답변은 “I wanted the interface to feel calm\.”입니다/u);
  assert.doesNotMatch(result.response.briefing_text, /사용자는|참여자는/u);
  assert.doesNotMatch(result.response.briefing_text, /focused decisions/u);
  assert.match(contract.SESSION_BRIEFING_PROMPT_VERSION, /v1\.3$/);
  const prompt = load("src/lib/ai/prompts/session-design-briefing-v1.3.ts").SESSION_DESIGN_BRIEFING_PROMPT;
  assert.match(prompt, /currently underway only when an answer says it is underway/u);
  assert.match(prompt, /Never convert a wish, possibility, or proposed next step/u);
  assert.match(prompt, /first-person voice of the designer/u);
  assert.equal(SESSION_DESIGN_BRIEFING_SCHEMA.name, contract.SESSION_BRIEFING_SCHEMA_VERSION);
});

test("briefing HTTP helpers reject cross-origin requests and oversized or invalid JSON bodies", async () => {
  assert.equal(hasSameOrigin({
    headers: new globalThis.Headers({ host: "localhost:3000", origin: "http://localhost:3000" }),
    nextUrl: new URL("http://localhost:3000/api"),
  }), true);
  assert.equal(hasSameOrigin({
    headers: new globalThis.Headers({ host: "localhost:3000", origin: "https://attacker.example" }),
    nextUrl: new URL("http://localhost:3000/api"),
  }), false);
  await assert.rejects(readJsonBody(new globalThis.Request("http://localhost", {
    method: "POST", body: "{\"ok\":true}",
  }), 4), /COMPLETION-LENGTH/u);
  await assert.rejects(readJsonBody(new globalThis.Request("http://localhost", {
    method: "POST", body: "{",
  }), 10), /COMPLETION-INPUT/u);
});

test("repository treats a missing durable briefing request as an explicit not-found contract", async () => {
  const client = {
    rpc() {
      return { abortSignal: async () => ({ data: null, error: null }) };
    },
  };
  const repo = createSessionBriefingRepository(client, client, "60000000-0000-4000-8000-000000000001");
  await assert.rejects(repo.read(sessionId, requestId), error =>
    error instanceof SessionBriefingRepositoryError && error.code === "BRIEFING-NOT-FOUND");
});

test("completion POST rejects cross-origin requests before auth or repository work and wires accepted TEST mock requests", async () => {
  let authCalls = 0;
  let serviceInput;
  const response = { json: (body, options = {}) => ({ body, status: options.status ?? 200, ...options }) };
  const route = load("src/app/api/sessions/[sessionId]/complete/route.ts", {
    "next/server": { NextResponse: response },
    "@/lib/ai/server/session-briefing-provider": {
      createSessionBriefingProvider: () => ({ provider: { generate: async () => ({}) }, mode: "mock" }),
    },
    "@/lib/ai/server/session-briefing-service": {
      runSessionBriefing: async (_repository, _provider, input) => {
        serviceInput = input;
        return requestRecord({ state: "completed" });
      },
    },
    "@/lib/answers/server": {
      AnswerError: class AnswerError extends Error {},
      requireActiveParticipant: async () => { authCalls++; return "60000000-0000-4000-8000-000000000001"; },
    },
    "@/lib/supabase/admin": { createSupabaseAdminClient: () => ({}) },
    "@/lib/supabase/server": { createSupabaseServerClient: async () => ({}) },
    "@/lib/session-completion/briefing-repository": {
      createSessionBriefingRepository: () => ({}),
    },
  });
  const makeRequest = (origin) => Object.assign(new globalThis.Request("http://localhost/api", {
    method: "POST",
    headers: { host: "localhost", origin, "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId, retry_of_request_id: null }),
  }), { nextUrl: new URL("http://localhost/api") });
  const context = { params: Promise.resolve({ sessionId }) };
  const rejected = await route.POST(makeRequest("https://attacker.example"), context);
  assert.equal(rejected.status, 403);
  assert.equal(authCalls, 0);
  const accepted = await route.POST(makeRequest("http://localhost"), context);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.provider_mode, "mock");
  assert.deepEqual(serviceInput, {
    session_id: sessionId, request_id: requestId, retry_of_request_id: null,
  });
  assert.equal(authCalls, 1);
});

  test("live briefing parameters send only confirmed context and selected final answers, not question assumptions or superseded answers", () => {
    const { sessionBriefingParameters, sessionBriefingConfig } = load("src/lib/ai/server/session-briefing-provider.ts");
    const params = sessionBriefingParameters("mock-model", snapshot);
    const payload = JSON.parse(params.input[0].content[0].text);
    assert.deepEqual(payload.final_answers, [{ slot_index: 1, answer: snapshot.answered_questions[0].answer.selected }]);
    assert.deepEqual(payload.participant_confirmed_context, { ...snapshot.design_context, context_ids: snapshot.context_ids });
    assert.doesNotMatch(JSON.stringify(payload), /What guided|I wanted it to feel calm|question_id|session_id/);
    assert.match(params.instructions, /not instructions|Do not invent intentions|uncertainty|unsupported causal links/);
    assert.match(params.instructions,/first-person voice of the designer/i);
    assert.match(params.instructions,/Do not refer to the designer as "the participant" or "the user"/);
    assert.equal(params.store, false);
    assert.equal(params.stream, false);
    assert.equal(params.text.format.strict, true);
    assert.equal(params.max_output_tokens, 4000);
    assert.throws(() => sessionBriefingConfig({}), /BRIEFING-CONFIG/);
    assert.throws(() => sessionBriefingParameters("mock", {
      ...snapshot, answered_questions: snapshot.answered_questions.map(q => ({
        ...q, answer: { ...q.answer, selected: q.answer.original },
      })),
    }), /BRIEFING-INPUT/);
  });

  test("OpenAI briefing SDK is mocked, retries disabled, bounded, and actual returned model retained", async () => {
    let options, sent, requestOptions;
    class FakeOpenAI {
      static APIError = class extends Error {};
      static APIConnectionTimeoutError = class extends Error {};
      constructor(config) {
        options = config;
        this.responses = { create: async (params, extra) => {
          sent = params; requestOptions = extra;
          return { status: "completed", model: "mock-model-snapshot",
            output: [{ type: "message", role: "assistant", status: "completed",
              content: [{ type: "output_text", text: JSON.stringify({ briefing_text: "사용자는 차분한 인터페이스를 원한다고 설명했습니다." }) }] }] };
        } };
      }
    }
    const providerModule = load("src/lib/ai/server/session-briefing-provider.ts", { openai: { default: FakeOpenAI } });
    const env = { NODE_ENV: "production", SESSION_BRIEFING_MOCK_ENABLED: "true",
      NEXT_PUBLIC_SUPABASE_URL: "https://njtgxnlxlhxpbiekbgmv.supabase.co",
      OPENAI_API_KEY: "mock-only-not-sent", OPENAI_SESSION_BRIEFING_ENABLED: "true", OPENAI_SESSION_BRIEFING_MODEL: "mock-model" };
    const { provider, mode } = providerModule.createSessionBriefingProvider(env);
    assert.equal(mode, "openai");
    const result = await provider.generate(snapshot);
    assert.equal(result.model_id, "mock-model-snapshot");
    assert.equal(options.maxRetries, 0);
    assert.equal(options.timeout, 45000);
    assert.equal(options.logLevel, "off");
    assert.equal(sent.model, "mock-model");
    assert.ok(requestOptions.signal instanceof globalThis.AbortSignal);
    const mock = providerModule.createSessionBriefingProvider({ ...env, NODE_ENV: "development" });
    assert.equal(mock.mode, "mock");
  });

  test("briefing output rejects refusals, partial responses, extra fields and tool output; errors distinguish safe retry from unknown dispatch", async () => {
    const module = load("src/lib/ai/server/session-briefing-provider.ts");
    const base = { status: "completed", model: "mock-model", output: [{
      type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: JSON.stringify({ briefing_text: "Grounded test." }) }],
    }] };
    for (const response of [
      { ...base, status: "incomplete" },
      { ...base, output: [] },
      { ...base, output: [...base.output, ...base.output] },
      { ...base, output: [{ type: "function_call" }] },
      { ...base, output: [{ ...base.output[0], content: [{ type: "refusal", refusal: "No" }] }] },
      { ...base, output: [{ ...base.output[0], content: [{ type: "output_text", text: '{"briefing_text":"ok","extra":true}' }] }] },
    ]) assert.throws(() => module.extractSessionBriefing(response), /BRIEFING-/);
    for (const [kind, status, unknown] of [["http", 429, false], ["http", 401, false],
      ["http", 500, true], ["timeout", null, true], ["network", null, true]]) {
      class APIError extends Error { constructor() { super("mock"); this.status = status; } }
      class Timeout extends Error {}
      class FakeOpenAI {
        static APIError = APIError;
        static APIConnectionTimeoutError = Timeout;
        constructor() { this.responses = { create: async () => {
          throw kind === "http" ? new APIError() : kind === "timeout" ? new Timeout() : new Error("Mock network");
        } }; }
      }
      const m = load("src/lib/ai/server/session-briefing-provider.ts", { openai: { default: FakeOpenAI } });
      const provider = m.createLiveSessionBriefingProvider({
        OPENAI_API_KEY: "mock", OPENAI_SESSION_BRIEFING_ENABLED: "true", OPENAI_SESSION_BRIEFING_MODEL: "mock",
      });
      await assert.rejects(provider.generate(snapshot), error => error.outcomeUnknown === unknown);
    }
  });
test("briefing GET returns the latest revision and PATCH preserves database CAS conflicts", async () => {
  const participantId = "60000000-0000-4000-8000-000000000001";
  const source = {
    session_id: sessionId, participant_id: participantId, request_id: requestId,
    source_text: "Source text.", model_id: "WHY-BOX-LOCAL-MOCK",
    prompt_version: contract.SESSION_BRIEFING_PROMPT_VERSION,
    schema_version: contract.SESSION_BRIEFING_SCHEMA_VERSION,
    generated_at: "2026-10-10T00:00:00Z",
  };
  const dataByTable = {
    profiles: { role: "participant", status: "active" },
    sessions: { id: sessionId, participant_id: participantId, status: "completed" },
    session_briefing_sources: source,
    session_briefing_versions: { revision: 2, briefing_text: "Latest revision.", edited_at: "2026-10-11T00:00:00Z" },
  };
  const query = data => ({
    select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; },
    maybeSingle: async () => ({ data, error: null }),
  });

  test("completion route accepts OpenAI mode and rejects disabled configuration before repository creation", async () => {
    let configured = true, runs = 0, repositories = 0;
    const route = load("src/app/api/sessions/[sessionId]/complete/route.ts", {
      "next/server": { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } },
      "@/lib/ai/server/session-briefing-provider": {
        createSessionBriefingProvider: () => {
          if (!configured) throw new SessionBriefingProviderError("BRIEFING-CONFIG", false);
          return { provider: {}, mode: "openai" };
        },
      },
      "@/lib/ai/server/session-briefing-service": {
        SessionBriefingProviderError,
        runSessionBriefing: async () => { runs++; return requestRecord({ state: "completed" }); },
      },
      "@/lib/answers/server": {
        AnswerError: class extends Error {},
        requireActiveParticipant: async () => "60000000-0000-4000-8000-000000000001",
      },
      "@/lib/supabase/admin": { createSupabaseAdminClient: () => ({}) },
      "@/lib/supabase/server": { createSupabaseServerClient: async () => ({}) },
      "@/lib/session-completion/briefing-repository": {
        createSessionBriefingRepository: () => { repositories++; return {}; },
      },
    });
    const request = () => Object.assign(new globalThis.Request("http://localhost/api", {
      method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ request_id: requestId }),
    }), { nextUrl: new URL("http://localhost/api") });
    const context = { params: Promise.resolve({ sessionId }) };
    const success = await route.POST(request(), context);
    assert.equal(success.status, 200);
    assert.equal(success.body.provider_mode, "openai");
    configured = false;
    const blocked = await route.POST(request(), context);
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.errorCode, "BRIEFING-CONFIG");
    assert.equal(runs, 1);
    assert.equal(repositories, 1);
  });
  let saveInput;
  const response = { json: (body, options = {}) => ({ body, status: options.status ?? 200, ...options }) };
  const route = load("src/app/api/sessions/[sessionId]/briefing/route.ts", {
    "next/server": { NextResponse: response },
    "@/lib/auth/session-error": { isInvalidAuthSession: () => false },
    "@/lib/answers/server": {
      AnswerError: class AnswerError extends Error {},
      requireActiveParticipant: async () => participantId,
    },
    "@/lib/supabase/server": {
      createSupabaseServerClient: async () => ({
        auth: { getUser: async () => ({ data: { user: { id: participantId } }, error: null }) },
        from: table => query(dataByTable[table]),
      }),
    },
    "@/lib/session-completion/briefing-repository": {
      createSessionBriefingRepository: () => ({
        saveVersion: async (id, expectedRevision, text) => {
          saveInput = { id, expectedRevision, text };
          return { saved: false, current_revision: 2 };
        },
      }),
    },
  });
  const context = { params: Promise.resolve({ sessionId }) };
  const read = await route.GET({}, context);
  assert.equal(read.status, 200);
  assert.equal(read.body.current, "Latest revision.");
  assert.equal(read.body.revision, 2);

  const edit = Object.assign(new globalThis.Request("http://localhost/api", {
    method: "PATCH",
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ expected_revision: 1, briefing_text: "My edit." }),
  }), { nextUrl: new URL("http://localhost/api") });
  const saved = await route.PATCH(edit, context);
  assert.equal(saved.status, 409);
  assert.deepEqual(saved.body, { errorCode: "BRIEFING-REVISION-CONFLICT", current_revision: 2 });
  assert.deepEqual(saveInput, { id: sessionId, expectedRevision: 1, text: "My edit." });
});

test("service dispatches one mock generation, validates it and records exact provenance", async () => {
  const repo = repository();
  let providerCalls = 0;
  const result = await runSessionBriefing(repo, {
    async generate(input) {
      providerCalls++;
      assert.deepEqual(input, snapshot);
      return { response: generated, model_id: "TEST-MOCK-MODEL" };
    },
  }, { session_id: sessionId, request_id: requestId });
  assert.equal(providerCalls, 1);
  assert.equal(result.state, "completed");
  assert.equal(repo.calls.complete.length, 1);
  assert.deepEqual(repo.calls.complete[0], {
    session_id: sessionId, request_id: requestId,
    briefing_text: generated.briefing_text, model_id: "TEST-MOCK-MODEL",
    prompt_version: contract.SESSION_BRIEFING_PROMPT_VERSION,
    schema_version: contract.SESSION_BRIEFING_SCHEMA_VERSION,
  });
});

test("concurrent same-request calls share a single dispatch and provider invocation", async () => {
  const repo = repository();
  const gate = deferred();
  let providerCalls = 0;
  const provider = {
    async generate() {
      providerCalls++;
      await gate.promise;
      return { response: generated, model_id: "TEST-MOCK-MODEL" };
    },
  };
  const input = { session_id: sessionId, request_id: requestId };
  const first = runSessionBriefing(repo, provider, input);
  const second = runSessionBriefing(repo, provider, input);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(providerCalls, 1);
  gate.resolve();
  const results = await Promise.all([first, second]);
  assert.ok(results.some(result => result.state === "completed"));
  assert.equal(providerCalls, 1);
  assert.equal(repo.calls.dispatch, 1);
  assert.equal(repo.calls.complete.length, 1);
});

test("definitive failure is recorded without automatic retry; explicit retry has its own request", async () => {
  const repo = repository();
  let providerCalls = 0;
  const provider = {
    async generate() {
      providerCalls++;
      if (providerCalls === 1) throw new SessionBriefingProviderError("BRIEFING-API", false);
      return { response: generated, model_id: "TEST-MOCK-MODEL" };
    },
  };
  const failed = await runSessionBriefing(repo, provider, { session_id: sessionId, request_id: requestId });
  assert.equal(failed.state, "failed");
  assert.equal(providerCalls, 1);
  assert.equal(repo.calls.fail[0].outcome_unknown, false);
  const retryId = "40000000-0000-4000-8000-000000000002";
  const retried = await runSessionBriefing(repo, provider, {
    session_id: sessionId, request_id: retryId, retry_of_request_id: requestId,
  });
  assert.equal(retried.state, "completed");
  assert.equal(providerCalls, 2);
});

test("unknown provider outcome is terminal on same-request replay and never dispatches again", async () => {
  const repo = repository();
  let providerCalls = 0;
  const provider = {
    async generate() {
      providerCalls++;
      throw new SessionBriefingProviderError("BRIEFING-TIMEOUT", true);
    },
  };
  const input = { session_id: sessionId, request_id: requestId };
  const first = await runSessionBriefing(repo, provider, input);
  const replay = await runSessionBriefing(repo, provider, input);
  assert.equal(first.state, "dispatch_unknown");
  assert.equal(replay.state, "dispatch_unknown");
  assert.equal(providerCalls, 1);
});

test("invalid provider output becomes a definitive failure and retains the request input", async () => {
  const repo = repository();
  const result = await runSessionBriefing(repo, {
    async generate() { return { response: { briefing_text: " " }, model_id: "TEST-MOCK-MODEL" }; },
  }, { session_id: sessionId, request_id: requestId });
  assert.equal(result.state, "failed");
  assert.equal(repo.calls.fail[0].failure_code, "BRIEFING-VALIDATION");
  assert.equal(repo.calls.fail[0].outcome_unknown, false);
  assert.equal(repo.calls.complete.length, 0);
});
