import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { typescriptLoader } from "./helpers/typescript-loader.mjs";

const { FormData } = globalThis;
const fixtureEmail = "existing-admin@example.invalid";
const fixtureId = "10000000-0000-4000-8000-000000000001";

function setup({ role = "admin", status = "active", signInError = null,
  userError = null, user = { id: fixtureId }, profileError = null } = {}) {
  const calls = { credentials: [], filters: [], errors: [], signOuts: 0 };
  const client = {
    auth: {
      async signInWithPassword(credentials) {
        calls.credentials.push(credentials);
        return { error: signInError };
      },
      async getUser() { return { data: { user }, error: userError }; },
      async signOut() { calls.signOuts++; return { error: null }; },
    },
    from(table) {
      assert.equal(table, "profiles");
      return {
        select() { return this; },
        eq(...args) { calls.filters.push(args); return this; },
        async maybeSingle() { return { data: { role, status }, error: profileError }; },
      };
    },
  };
  const load = typescriptLoader({
    "next/navigation": { redirect(location) { throw new Error(`REDIRECT:${location}`); } },
    "@/lib/supabase/server": { createSupabaseServerClient: async () => client },
    "@/lib/errors/report": { reportError: async (...args) => { calls.errors.push(args); } },
  });
  return { calls, signIn: load("src/app/(auth)/login/actions.ts").signIn };
}

async function withAlias(value, run) {
  const old = process.env.WHY_BOX_ADMIN_AUTH_EMAIL;
  if (value === undefined) delete process.env.WHY_BOX_ADMIN_AUTH_EMAIL;
  else process.env.WHY_BOX_ADMIN_AUTH_EMAIL = value;
  try { await run(); }
  finally {
    if (old === undefined) delete process.env.WHY_BOX_ADMIN_AUTH_EMAIL;
    else process.env.WHY_BOX_ADMIN_AUTH_EMAIL = old;
  }
}

function form(identifier, password = "synthetic-password") {
  const data = new FormData();
  data.set("identifier", identifier);
  data.set("password", password);
  return data;
}

test("admin alias uses server configuration and authenticated UUID without changing credentials", async () => {
  await withAlias(` ${fixtureEmail} `, async () => {
    for (const identifier of ["admin", " ADMIN "]) {
      const s = setup();
      await assert.rejects(s.signIn(form(identifier)), /^Error: REDIRECT:\/admin$/);
      assert.deepEqual(s.calls.credentials, [{ email: fixtureEmail, password: "synthetic-password" }]);
      assert.deepEqual(s.calls.filters, [["id", fixtureId]]);
      assert.deepEqual(s.calls.errors, []);
    }
  });
});

test("missing or invalid alias configuration fails explicitly without Auth calls or leaking values", async () => {
  for (const value of [undefined, "", "not-an-email", "admin"]) {
    await withAlias(value, async () => {
      const s = setup();
      await assert.rejects(s.signIn(form("admin")), /^Error: REDIRECT:\/login\?error=AUTH-004$/);
      assert.deepEqual(s.calls.credentials, []);
      assert.deepEqual(s.calls.errors, [["AUTH-004", "login.admin_alias.config"]]);
    });
  }
});

test("wrong admin password cannot reach profile authorization", async () => {
  await withAlias(fixtureEmail, async () => {
    const s = setup({ signInError: { code: "invalid_credentials" } });
    await assert.rejects(s.signIn(form("admin", "wrong-password")),
      /^Error: REDIRECT:\/login\?error=AUTH-001$/);
    assert.deepEqual(s.calls.filters, []);
    assert.equal(s.calls.errors[0][0], "AUTH-001");
    assert.ok(!JSON.stringify(s.calls.errors).includes(fixtureEmail));
  });
});

test("inactive administrator is signed out and denied", async () => {
  await withAlias(fixtureEmail, async () => {
    const s = setup({ status: "deactivated" });
    await assert.rejects(s.signIn(form("admin")), /^Error: REDIRECT:\/login\?error=AUTH-002$/);
    assert.equal(s.calls.signOuts, 1);
  });
});

test("alias mapped to a participant never grants administrator access", async () => {
  await withAlias(fixtureEmail, async () => {
    const s = setup({ role: "participant" });
    await assert.rejects(s.signIn(form("admin")), /^Error: REDIRECT:\/$/);
    assert.deepEqual(s.calls.filters, [["id", fixtureId]]);
  });
});

test("email and P01 logins remain available with no alias configuration", async () => {
  await withAlias(undefined, async () => {
    for (const [identifier, email, role] of [
      [fixtureEmail, fixtureEmail, "admin"],
      [" p01 ", "p01@participants.whybox.invalid", "participant"],
      [" t01 ", "t01@participants.whybox.invalid", "participant"],
    ]) {
      const s = setup({ role });
      await assert.rejects(s.signIn(form(identifier)),
        role === "admin" ? /^Error: REDIRECT:\/admin$/ : /^Error: REDIRECT:\/$/);
      assert.equal(s.calls.credentials[0].email, email);
    }
  });
});

test("invalid identifiers and empty passwords never attempt authentication", async () => {
  await withAlias(fixtureEmail, async () => {
    for (const data of [form("invalid"), form("P1"), form(""), form("admin", "")]) {
      const s = setup();
      await assert.rejects(s.signIn(data), /^Error: REDIRECT:\/login\?error=AUTH-001$/);
      assert.deepEqual(s.calls.credentials, []);
    }
  });

  test("renamed T01 login authorizes the same UUID; old P01 mapping has no automatic alias", async () => {
    await withAlias(undefined, async () => {
      const renamed = setup({ role: "participant" });
      await assert.rejects(renamed.signIn(form("T01")), /^Error: REDIRECT:\/$/);
      assert.equal(renamed.calls.credentials[0].email, "t01@participants.whybox.invalid");
      assert.deepEqual(renamed.calls.filters, [["id", fixtureId]]);
      const old = setup({ role: "participant", signInError: { code: "invalid_credentials" } });
      await assert.rejects(old.signIn(form("P01")), /^Error: REDIRECT:\/login\?error=AUTH-001$/);
      assert.equal(old.calls.credentials[0].email, "p01@participants.whybox.invalid");
      assert.deepEqual(old.calls.filters, []);
    });
  });
});

test("Auth verification and profile errors cannot produce successful alias login", async () => {
  await withAlias(fixtureEmail, async () => {
    for (const options of [
      { userError: { code: "unexpected_failure" } },
      { profileError: { code: "database_failure" } },
    ]) {
      const s = setup(options);
      await assert.rejects(s.signIn(form("admin")), /^Error: REDIRECT:\/login\?error=AUTH-004$/);
      assert.equal(s.calls.errors[0][0], "AUTH-004");
    }
    await assert.rejects(setup({ user: null }).signIn(form("admin")),
      /^Error: REDIRECT:\/login\?error=AUTH-001$/);
  });
});
