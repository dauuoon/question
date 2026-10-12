import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import { NextRequest } from "next/server.js";
import process from "node:process";
import { typescriptLoader } from "./helpers/typescript-loader.mjs";
import { IMAGE_BUCKET, MAX_IMAGE_BYTES, validateImageFile } from "../src/lib/images/limits.ts";

const require = createRequire(import.meta.url);
const { Response } = globalThis;
function load(path, mocks) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
    (name) => Object.hasOwn(mocks, name) ? mocks[name] :
      name.startsWith("@/") ? typescriptLoader(mocks)(`src/${name.slice(2)}.ts`) : require(name), module, module.exports);
  return module.exports;
}
const owner = "10000000-0000-4000-8000-000000000001";
const session = "20000000-0000-4000-8000-000000000001";
const image = "30000000-0000-4000-8000-000000000001";
const path = `${owner}/${session}/${image}-private.png`;
const originalEnabled = process.env.SESSION_IMAGE_DELETION_ENABLED;

function api(options = {}) {
  const calls = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: owner } }, error: null }) },
    from(table) { return { select() { return this; }, eq() { return this; }, is() { return this; },
      maybeSingle: async () => ({ data: { role: "participant", status: "active" }, error: null }),
      order: async () => ({ data: [{ id: image, original_filename: "TEST.png", storage_path: path, sort_order: 0 }], error: null }),
      then(resolve) { calls.push(`query:${table}`); return Promise.resolve({ data: options.pending ? [{ image_id: image }] : [],
        error: null }).then(resolve); },
    }; },
    async rpc(name) {
      calls.push(name);
      if (name === "begin_image_deletion") return { data: [{ storage_path: path, completed: !!options.completed }],
        error: options.denied ? { code: "42501" } : null };
      return { data: options.changed ?? true, error: options.finishError ? { code: "23514" } : null };
    },
    storage: { from() { return { createSignedUrl: async () => {
      calls.push("sign"); return { data: { signedUrl: "https://preview.invalid/TEST" }, error: null };
    }, remove: async (paths) => {
      calls.push("storage"); assert.deepEqual(paths, [path]);
      return { error: options.storageError ? { status: 503 } : null };
    } }; } },
  };
  const route = load("../src/app/api/session-images/route.ts", {
    "@/lib/supabase/server": { createSupabaseServerClient: async () => client },
    "@/lib/errors/report": { reportError: async (code, operation) => {
      calls.push(operation); return { errorCode: code, message: code, retryable: code === "UPLOAD-008" };
    } },
    "@/lib/images/limits": { IMAGE_BUCKET, MAX_IMAGE_BYTES, validateImageFile },
    "@/lib/activity/record": { recordParticipantActivity: async (event) => { calls.push(event); return true; } },
  });
  const send = async (origin = "http://localhost:3000") => {
    const response = await route.DELETE(new NextRequest(
      `http://localhost:3000/api/session-images?session_id=${session}&image_id=${image}`, {
        method: "DELETE", headers: { host: "localhost:3000", origin },
      }));
    return { status: response.status, body: await response.json() };
  };
  const list = async () => {
    const response = await route.GET(new NextRequest(`http://localhost:3000/api/session-images?session_id=${session}`));
    return response.json();
  };
  return { calls, send, list };
}

test("DELETE confirms Storage before returning capacity and never leaks private paths", async () => {
  process.env.SESSION_IMAGE_DELETION_ENABLED = "true";
  try {
    const s = api();
    const result = await s.send();
    assert.equal(result.status, 200);
    assert.deepEqual(s.calls, ["begin_image_deletion", "storage", "finish_image_deletion", "image_deleted"]);
    assert.equal(JSON.stringify(result).includes(path), false);
  } finally { restoreEnabled(); }
});

test("DELETE retains pending operation on Storage/DB failure, idempotent completion skips Storage/activity", async () => {
  process.env.SESSION_IMAGE_DELETION_ENABLED = "true";
  try {
    const storage = api({ storageError: true });
    assert.equal((await storage.send()).body.errorCode, "UPLOAD-008");
    assert.equal(storage.calls.includes("finish_image_deletion"), false);
    const finish = api({ finishError: true });
    assert.equal((await finish.send()).body.errorCode, "UPLOAD-008");
    assert.equal(finish.calls.includes("image_deleted"), false);
    const completed = api({ completed: true });
    assert.equal((await completed.send()).body.changed, false);
    assert.deepEqual(completed.calls, ["begin_image_deletion"]);
    const unchanged = api({ changed: false });
    assert.equal((await unchanged.send()).body.changed, false);
    assert.equal(unchanged.calls.includes("image_deleted"), false);
  } finally { restoreEnabled(); }
});

test("DELETE rejects origin, inaccessible/frozen sessions and remains gated until migration approval", async () => {
  process.env.SESSION_IMAGE_DELETION_ENABLED = "true";
  try {
    const origin = api(); assert.equal((await origin.send("https://foreign.invalid")).status, 403);
    assert.equal(origin.calls.includes("begin_image_deletion"), false);
    const denied = api({ denied: true }); assert.equal((await denied.send()).body.errorCode, "UPLOAD-009");
    assert.equal(denied.calls.includes("storage"), false);
    process.env.SESSION_IMAGE_DELETION_ENABLED = "false";
    const gated = api(); assert.equal((await gated.send()).status, 409);
    assert.equal(gated.calls.includes("begin_image_deletion"), false);
  } finally { restoreEnabled(); }
});

test("GET exposes recoverable pending deletion without trying to sign a removed object; disabled flag preserves legacy list", async () => {
  process.env.SESSION_IMAGE_DELETION_ENABLED = "true";
  try {
    const pending = api({ pending: true });
    const list = await pending.list();
    assert.equal(list.images[0].deletionPending, true);
    assert.equal(list.images[0].previewUrl, null);
    assert.equal(pending.calls.includes("sign"), false);
    assert.equal(JSON.stringify(list).includes(path), false);
    process.env.SESSION_IMAGE_DELETION_ENABLED = "false";
    const legacy = api();
    const original = await legacy.list();
    assert.equal(original.deletionEnabled, false);
    assert.equal(legacy.calls.includes("query:image_deletions"), false);
    assert.ok(original.images[0].previewUrl);
  } finally { restoreEnabled(); }
});

test("AI draft preparation rejects pending deletion before claiming or signing images", async () => {
  process.env.SESSION_IMAGE_DELETION_ENABLED = "true";
  try {
    const calls = [];
    class DraftError extends Error { constructor(code) { super(code); this.code = code; } }
    const { prepareDraft } = load("../src/lib/ai/server/context-draft-service.ts", {
      "server-only": {}, "../context-draft-contract": { DraftError },
      "../../images/limits": { IMAGE_BUCKET }, "./config": { DRAFT_SIGNED_URL_SECONDS: 60 },
    });
    const client = {
      from(table) { return { select() { return this; }, eq() { return this; }, is() { return this; },
        maybeSingle: async () => ({ data: { status: "draft" }, error: null }),
        then(resolve) { return Promise.resolve(table === "questions" ? { count: 0, error: null } :
          { data: [{ image_id: image }], error: null }).then(resolve); },
      }; },
      rpc: () => calls.push("claim"), storage: { from: () => calls.push("sign") },
    };
    await assert.rejects(prepareDraft(client, owner, { session_id: session }), { code: "DRAFT-IMAGE" });
    assert.deepEqual(calls, []);
  } finally { restoreEnabled(); }
});

function restoreEnabled() {
  if (originalEnabled === undefined) delete process.env.SESSION_IMAGE_DELETION_ENABLED;
  else process.env.SESSION_IMAGE_DELETION_ENABLED = originalEnabled;
}
function nodes(element) {
  if (Array.isArray(element)) return element.flatMap(nodes);
  if (!element || typeof element !== "object") return [];
  return [element, ...nodes(element.props?.children)];
}

test("uploader confirms deletion, serializes requests, updates image revision and refreshes only on server success", async () => {
  const originalFetch = globalThis.fetch;
  let cursor = 0, mounted = false, removed = false, deletionEnabled = true, deletedCalls = 0, resolveDelete;
  const slots = [], revisions = [], counts = [];
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback: (fn) => fn, useEffect(fn) { if (!mounted) fn(); },
  };
  globalThis.fetch = async (_, options) => {
    if (options?.method === "DELETE") {
      deletedCalls++;
      return new Promise((resolve) => { resolveDelete = () => {
        removed = true; resolve(Response.json({ success: true, changed: true, activityRecorded: true }));
      }; });
    }
    return Response.json({ deletionEnabled, images: removed ? [] : [
      { id: image, original_filename: "TEST.png", sort_order: 0, previewUrl: "https://preview.invalid/TEST" },
    ] });
  };
  try {
    const { ImageUploader } = load("../src/app/(participant)/sessions/[sessionId]/image-uploader.tsx", {
      react: hooks, "@/app/toast": { Toast: () => null },
      "@/app/loading-state": { LoadingState: (props) => ({ type: "loading-state", props }) },
      "@/lib/images/limits": { IMAGE_BUCKET, MAX_IMAGE_BYTES, MAX_IMAGE_COUNT: 10, validateImageFile },
      "@/lib/errors/catalog": requireCatalog(),
      "@/lib/images/upload-request": { prepareImageUploads: () => [], unsavedImageUploads: (uploads) => uploads },
    });
    const render = () => { cursor = 0; const result = nodes(ImageUploader({
      sessionId: session, editable: true, onImageRevisionChange: (revision) => revisions.push(revision),
      onImageCountChange: (count) => counts.push(count),
    })); mounted = true; return result; };
    const initialTree = render();
    const loading = initialTree.find((node) => node.type?.name === "LoadingState");
    assert.equal(loading.props.children, "저장된 이미지 목록을 확인하고 있어요.");
    assert.equal(initialTree.some((node) => node.props?.message === "이미지를 불러오는 중입니다…"), false);
    await settle();
    let tree = render();
    const actions = tree.find((node) => node.props?.className === "image-actions");
    assert.ok(nodes(actions).find((node) => node.props?.className === "upload-count"));
    const refreshButton = nodes(actions).find((node) => node.type === "button" &&
      node.props.children === "이미지 목록 새로고침");
    assert.equal(refreshButton.props.hidden, true);
    assert.equal(refreshButton.props.disabled, true);
    assert.equal(typeof refreshButton.props.onClick, "function");
    const removeButton = tree.find((node) => node.props?.["aria-label"] === "TEST.png 삭제");
    assert.equal(removeButton.props.disabled, false);
    removeButton.props.onClick();
    tree = render();
    const confirmation = tree.find((node) => node.props?.role === "alertdialog");
    assert.match(JSON.stringify(confirmation.props.children), /복구할 수 없습니다/);
    assert.equal(deletedCalls, 0);
    const deleteConfirm = nodes(confirmation).find((node) => node.type === "button" &&
      node.props.children === "삭제");
    deleteConfirm.props.onClick();
    deleteConfirm.props.onClick();
    assert.equal(deletedCalls, 1);
    assert.match(revisions.at(-1), /^deleting:/);
    assert.equal(render().filter((node) => node.type === "figure").length, 1);
    resolveDelete(); await settle();
    assert.equal(render().filter((node) => node.type === "figure").length, 0);
    assert.equal(counts.at(-1), 0);
    removed = false;
    deletionEnabled = false;
    const refresh = render().find((node) => node.type === "button" && node.props.children === "이미지 목록 새로고침");
    refresh.props.onClick();
    await settle();
    tree = render();
    const unavailableDelete = tree.find((node) => node.props?.["aria-label"] === "TEST.png 삭제");
    assert.equal(unavailableDelete.props.disabled, false);
    unavailableDelete.props.onClick();
    const unavailableDialog = render().find((node) => node.props?.role === "alertdialog");
    assert.match(JSON.stringify(unavailableDialog.props.children), /이 환경에서 활성화되지 않았습니다/u);
    assert.equal(nodes(unavailableDialog).find((node) => node.type === "button" &&
      node.props.children === "삭제").props.disabled, true);
  } finally { globalThis.fetch = originalFetch; }
});
function requireCatalog() { return load("../src/lib/errors/catalog.ts", {}); }
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
