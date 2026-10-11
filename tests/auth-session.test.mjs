import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { runInThisContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path, mocks = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
    (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name), module, module.exports,
  );
  return module.exports;
}
const classifier = load("../src/lib/auth/session-error.ts");
const expired = { name: "AuthApiError", status: 400, code: "refresh_token_already_used" };
const transient = { name: "AuthRetryableFetchError", status: 503 };

test("invalid refresh/session credentials are separated from transport and unexpected Auth failures", () => {
  for (const error of [
    expired, { ...expired, code: "refresh_token_not_found" },
    { ...expired, code: "session_not_found" }, { ...expired, code: "bad_jwt" },
    { name: "AuthSessionMissingError" }, { name: "AuthApiError", status: 401 },
  ]) assert.equal(classifier.isInvalidAuthSession(error), true);
  for (const error of [
    transient, { name: "AuthRetryableFetchError", status: 0 },
    { name: "AuthApiError", status: 429 }, { name: "AuthApiError", status: 400, code: "unexpected_failure" },
  ]) assert.equal(classifier.isInvalidAuthSession(error), false);
});

function roleSetup({ error = null, user = true, role = "admin", status = "active" } = {}) {
  const calls = { errors: [], profiles: 0 };
  const query = {
    select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: { role, status }, error: null }; },
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: user ? { id: "TEST-user" } : null }, error }) },
    from() { calls.profiles++; return query; },
  };
  const module = load("../src/lib/auth/role.ts", {
    "next/navigation": { redirect: (location) => { throw new Error(`REDIRECT:${location}`); } },
    "@/lib/auth/session-error": classifier,
    "@/lib/performance/request": {},
    "@/lib/supabase/server": { createSupabaseServerClient: async () => client },
    "@/lib/errors/report": { reportError: async (...args) => { calls.errors.push(args); } },
  });
  return { calls, check: module.requireRole };
}

test("expired refresh tokens redirect explicitly without reaching the profile query", async () => {
  for (const code of ["refresh_token_already_used", "refresh_token_not_found", "session_not_found", "bad_jwt"]) {
    const s = roleSetup({ error: { ...expired, code }, user: false });
    await assert.rejects(s.check("admin"), /REDIRECT:\/login\?error=AUTH-005/);
    assert.equal(s.calls.profiles, 0);
    assert.equal(s.calls.errors[0][0], "AUTH-005");
  }
});

test("missing sessions redirect normally; network errors remain logged failures", async () => {
  const missing = roleSetup({ error: { name: "AuthSessionMissingError" }, user: false });
  await assert.rejects(missing.check("admin"), /^Error: REDIRECT:\/login$/);
  assert.equal(missing.calls.errors.length, 0);
  const s = roleSetup({ error: transient, user: false });
  await assert.rejects(s.check("admin"), /Unable to verify the current session/);
  assert.equal(s.calls.errors[0][0], "AUTH-004");
});

test("active Admin still succeeds and inactive/wrong-role profiles are denied", async () => {
  await roleSetup().check("admin");
  await assert.rejects(roleSetup({ status: "deactivated" }).check("admin"), /REDIRECT:\/login\?error=AUTH-002/);
  await assert.rejects(roleSetup({ role: "participant" }).check("admin"), /^Error: REDIRECT:\/$/);
});

test("proxy permits invalid-session cleanup cookies but never swallows infrastructure errors", async () => {
  for (const error of [expired, { name: "AuthSessionMissingError" }, transient]) {
    const responses = [];
    const proxy = load("../proxy.ts", {
      "@/lib/performance/request": {},
      "@/lib/env": { getPublicEnv: () => ({ NEXT_PUBLIC_SUPABASE_URL: "https://test.invalid", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "TEST" }) },
      "@/lib/auth/session-error": classifier,
      "@supabase/ssr": { createServerClient: (_url, _key, options) => ({
        auth: { getUser: async () => {
          options.cookies.setAll([{ name: "TEST-cookie", value: "", options: { maxAge: 0 } }]);
          return { error };
        } },
      }) },
      "next/server": { NextResponse: { next: () => {
        const response = { cookies: { set: (...args) => { responses.push(args); } } };
        return response;
      } } },
    }).proxy;
    const request = { cookies: { getAll: () => [], set: () => {} } };
    if (error === transient) await assert.rejects(proxy(request), /Unable to refresh/);
    else {
      const result = await proxy(request);
      assert.ok(result.cookies);
      assert.deepEqual(responses[0], ["TEST-cookie", "", { maxAge: 0 }]);
    }
  }
});
