import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { runInThisContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { ACTIVITY_INTERVAL_MS, formatResearchDate, researchScreenSession } from "../src/lib/activity/screen.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/lib/activity/record.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function setup({ role = "participant", status = "active", user = true, rpcError = false, throwRpc = false, updated = true } = {}) {
  const calls = { adminCreated: 0, rpc: [], errors: [] };
  const profileQuery = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data: { role, status }, error: null }; },
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: user ? { id: "TEST-authenticated-id" } : null }, error: null }) },
    from: () => profileQuery,
  };
  const localRequire = (name) => {
    if (name === "server-only") return {};
    if (name === "@/lib/supabase/server") return { createSupabaseServerClient: async () => client };
    if (name === "@/lib/supabase/admin") return {
      createSupabaseAdminClient() {
        calls.adminCreated++;
        return { rpc: async (name, args) => {
          calls.rpc.push({ name, args });
          if (throwRpc) throw new Error("TEST simulated transport failure");
          return { data: updated, error: rpcError ? { code: "PGRST202" } : null };
        } };
      },
    };
    if (name === "@/lib/errors/report") return {
      reportError: async (...args) => { calls.errors.push(args); return {}; },
    };
    return require(name);
  };
  const module = { exports: {} };
  runInThisContext(`(function(require,module,exports){${compiled}\n})`)(localRequire, module, module.exports);
  return { calls, record: module.exports.recordParticipantActivity };
}

test("active Participant identity is derived from verified Auth; no client date is passed", async () => {
  const s = setup();
  assert.equal(await s.record("session_created"), true);
  assert.deepEqual(s.calls.rpc, [{
    name: "record_participant_activity", args: { p_participant_id: "TEST-authenticated-id" },
  }]);
});

test("Admin, inactive Participant and unauthenticated requests do not reach the privileged RPC", async () => {
  for (const options of [{ role: "admin" }, { status: "deactivated" }, { user: false }]) {
    const s = setup(options);
    assert.equal(await s.record("screen_access"), false);
    assert.equal(s.calls.adminCreated, 0);
    assert.equal(s.calls.rpc.length, 0);
  }
});

test("throttled no-op is successful; RPC/transport failures are explicitly logged", async () => {
  assert.equal(await setup({ updated: false }).record("image_uploaded"), true);
  for (const options of [{ rpcError: true }, { throwRpc: true }]) {
    const s = setup(options);
    assert.equal(await s.record("image_uploaded"), false);
    assert.ok(s.calls.errors.some((error) => error[0] === "SAVE-002"));
  }
});

test("screen allowlist excludes Admin, invalid session, query strings, and API/background endpoints", () => {
  assert.equal(researchScreenSession("/"), null);
  assert.equal(researchScreenSession("/history"), null);
  assert.equal(researchScreenSession("/sessions/new"), null);
  assert.equal(researchScreenSession("/sessions/20000000-0000-4000-8000-000000000001"), "20000000-0000-4000-8000-000000000001");
  for (const path of ["/admin", "/admin/participants", "/api/session-images", "/sessions/invalid", "/?refresh=1"]) {
    assert.equal(researchScreenSession(path), undefined);
  }
});

test("NULL and date formatting use the existing Korean/Seoul calendar date", () => {
  assert.equal(formatResearchDate(null), "사용 기록 없음");
  assert.equal(formatResearchDate("2026-10-03T23:30:00Z"), "2026. 10. 4.");
  assert.equal(ACTIVITY_INTERVAL_MS, 300000);
});

test("migration uses server time, atomic five-minute throttle, no backfill and only Service Role RPC grants", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261004150000_participant_last_activity.sql", import.meta.url), "utf8");
  assert.match(sql, /add column last_activity_at timestamptz;/);
  assert.match(sql, /clock_timestamp\(\)/);
  assert.match(sql, /p\.last_activity_at < v_now - interval '5 minutes'/);
  assert.match(sql, /p\.role = 'participant' and p\.status = 'active'/);
  assert.match(sql, /grant execute .* to service_role;/);
  assert.doesNotMatch(sql, /grant .* to authenticated/);
  assert.doesNotMatch(sql, /default|drop policy|alter policy/i);
  const marker = readFileSync(new URL("../src/app/(participant)/activity-marker.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(marker, /setInterval|setTimeout/);
  assert.match(marker, /document\.visibilityState !== "visible"/);
  assert.match(marker, /lastPath === path/);
});
