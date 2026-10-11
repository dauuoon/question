import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { typescriptLoader } from "./helpers/typescript-loader.mjs";

test("Admin meets the minimum exactly at five completed sessions and still shows all additional uses", async () => {
  for (const count of [4, 5, 6, 10]) {
    const profile = { id: "10000000-0000-4000-8000-000000000001",
      participant_code: "P99001", account_type: "P", status: "active",
      created_at: "2026-10-11T10:00:00Z", last_activity_at: null, completed: count, diaries: count - 1 };
    let calls = 0;
    const client = { async rpc(name, args) {
      calls++;
      assert.equal(name, "admin_participants_read");
      assert.deepEqual(args, { p_page: 1, p_filter: "all" });
      return { data: { rows: [profile], page: 1, pages: 1, filter: "all" }, error: null };
    } };
    const load = typescriptLoader({
      "@/lib/auth/role": { requireRole: async () => ({ supabase: client }) },
      "./account-forms": { CreateParticipantForm: () => null, ManageParticipantForm: () => null, ChangeAccountTypeForm: () => null },
      "next/link": { default: ({ children }) => children },
      "@/lib/activity/screen": { formatResearchDate: () => "-" },
    });
    const page = load("src/app/(admin)/admin/participants/page.tsx");
    const html = renderToStaticMarkup(await page.default());
    assert.match(html, new RegExp(`최소 5회 사용 ${count < 5 ? "미충족" : "충족"}`));
    assert.match(html, new RegExp(`도구 사용 ${count}회`));
    assert.match(html, new RegExp(`다이어리 작성 ${count - 1}회`));
    assert.equal(calls, 1);
  }
});

test("spec uses minimum five, no cap, and per-session diaries; session creation has no five-use restriction", () => {
  const spec = readFileSync(new URL("../WHY_BOX_SPEC.md", import.meta.url), "utf8");
  assert.doesNotMatch(spec, /6회/);
  assert.match(spec, /최소 5회/);
  assert.match(spec, /완료 횟수 상한은 없다/);
  assert.match(spec, /5회 초과 세션에도 동일한 다이어리/);
  const create = readFileSync(new URL("../src/app/(participant)/sessions/new/actions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(create, /MINIMUM_COMPLETED_SESSIONS|count.*completed/);
});
