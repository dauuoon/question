import assert from "node:assert/strict";
import { Blob, File, Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import test from "node:test";
import sharp from "sharp";
import { typescriptLoader } from "./helpers/typescript-loader.mjs";
const { Request, Response } = globalThis;

const participantId = "10000000-0000-4000-8000-000000000001";
const sessionId = "20000000-0000-4000-8000-000000000001";
const requestId = "30000000-0000-4000-8000-000000000001";
const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#FD8A5E" } }).png().toBuffer();
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const input = {
  session_id: sessionId, request_id: requestId, original_filename: "TEST.png",
  mime_type: "image/png", file_size: png.length, content_sha256: digest(png),
};
const storagePath = `${participantId}/${sessionId}/${requestId}-${input.content_sha256}.png`;

function scenario(options = {}) {
  const calls = { reservations: [], downloads: [], finalized: [], errors: [] };
  let record = false;
  let fail = options.failOnce;
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: participantId } }, error: null }) },
    rpc: async (name, parameters) => {
      if (name === "read_direct_image_upload_capability") {
        return { data: options.missingMigration ? null : 1, error: options.missingMigration ? { code: "PGRST202" } : null };
      }
      assert.equal(name, "reserve_image_upload");
      calls.reservations.push(parameters);
      if (options.reserveError) return { data: null, error: { code: options.reserveError } };
      const path = `${participantId}/${sessionId}/${parameters.p_request_id}-${parameters.p_content_sha256}.${parameters.p_extension}`;
      return { data: [{ storage_path: options.foreignPath ? `foreign/${path}` : path,
        slot_index: 1, sort_order: 0 }], error: null };
    },
    from(table) {
      const query = {
        select() { return query; }, eq() { return query; },
        async maybeSingle() {
          if (table === "profiles") return { data: { role: "participant", status: options.inactive ? "deactivated" : "active" }, error: null };
          if (table === "sessions") return { data: options.foreignSession ? null : { status: options.frozen ? "in_progress" : "draft" }, error: null };
          throw new Error("No direct metadata access permitted.");
        },
        then(resolve, reject) { return Promise.resolve({ count: 0, error: null }).then(resolve, reject); },
      };
      return query;
    },
    storage: { from(bucket) {
      assert.equal(bucket, "why-box-images");
      return { async download(path) {
        calls.downloads.push(path);
        const bytes = options.bytes ?? png;
        return { data: options.missingObject ? null : new Blob([bytes]),
          error: options.missingObject ? { status: 404 } : null };
      } };
    } },
  };
  const load = typescriptLoader({
    sharp: { default: sharp },
    "@/lib/activity/record": { recordParticipantActivity: async () => true },
    "@/lib/supabase/server": { createSupabaseServerClient: async () => client },
    "@/lib/supabase/admin": { createSupabaseAdminClient: () => ({
      async rpc(name, parameters) {
        assert.equal(name, "finish_verified_image_upload");
        calls.finalized.push(parameters);
        if (fail) {
          fail = false;
          if (options.ambiguousCommit) record = true;
          return { data: null, error: { code: "NETWORK" } };
        }
        const changed = !record;
        record = true;
        return { data: changed, error: null };
      },
    }) },
    "@/lib/errors/report": { reportError: async (code, operation) => {
      calls.errors.push({ code, operation });
      return { errorCode: code, message: code, retryable: !["UPLOAD-002", "UPLOAD-004", "UPLOAD-005", "UPLOAD-007", "AUTH-002"].includes(code) };
    } },
  });
  const route = load("src/app/api/session-images/route.ts");
  async function send(action = "finalize", changes = {}, headers = {}) {
    const request = Object.assign(new Request("http://localhost/api/session-images", {
      method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
      body: JSON.stringify({ ...input, action, ...changes }),
    }), { nextUrl: new URL("http://localhost/api/session-images") });
    const response = await route.POST(request);
    return { status: response.status, body: await response.json() };
  }
  return { calls, send };
}

test("reservation accepts only small JSON and does not download or finalize an image", async () => {
  const s = scenario();
  assert.deepEqual((await s.send("reserve")).body, { storage_path: storagePath });
  assert.equal(s.calls.downloads.length, 0);
  assert.equal(s.calls.finalized.length, 0);
  assert.equal((await s.send("reserve", {}, { "content-type": "multipart/form-data" })).status, 415);
  assert.equal((await s.send("reserve", { extra: "x".repeat(5000) })).status, 413);
});

test("finalize verifies object hash, real format, dimensions and passes only trusted metadata to the RPC", async () => {
  const s = scenario();
  assert.equal((await s.send()).body.success, true);
  assert.deepEqual(s.calls.downloads, [storagePath]);
  assert.deepEqual(s.calls.finalized[0], {
    p_session_id: sessionId, p_request_id: requestId, p_participant_id: participantId,
    p_content_sha256: digest(png), p_mime_type: "image/png", p_file_size: png.length,
    p_original_filename: "TEST.png", p_width: 4, p_height: 4,
  });
  assert.equal((await s.send()).body.success, true);
  assert.deepEqual(s.calls.reservations[0], s.calls.reservations[1]);
});

test("metadata failure and lost commit response retain same path and are safe to retry", async () => {
  for (const ambiguousCommit of [false, true]) {
    const s = scenario({ failOnce: true, ambiguousCommit });
    assert.equal((await s.send()).body.errorCode, "UPLOAD-006");
    assert.equal((await s.send()).body.success, true);
    assert.deepEqual(s.calls.reservations[0], s.calls.reservations[1]);
    assert.ok(s.calls.errors.some(error => error.operation === "image.metadata.reservation_retained"));
  }
});

test("overlapping finalize requests verify the same path and reconcile one metadata record", async () => {
  const s = scenario();
  const results = await Promise.all([s.send(), s.send()]);
  assert.ok(results.every(result => result.body.success));
  assert.deepEqual(s.calls.finalized[0], s.calls.finalized[1]);
});

test("foreign path/session, inactive/frozen accounts, absent migration and reservation denial fail closed", async () => {
  for (const [options, code] of [
    [{ foreignPath: true }, "UPLOAD-007"], [{ foreignSession: true }, "UPLOAD-005"],
    [{ inactive: true }, "AUTH-002"], [{ frozen: true }, "UPLOAD-005"],
    [{ missingMigration: true }, "UPLOAD-001"], [{ reserveError: "23514" }, "UPLOAD-004"],
    [{ reserveError: "42501" }, "UPLOAD-005"], [{ reserveError: "22023" }, "UPLOAD-007"],
  ]) {
    const s = scenario(options);
    assert.equal((await s.send()).body.errorCode, code);
    assert.equal(s.calls.downloads.length, 0);
    assert.equal(s.calls.finalized.length, 0);
  }
  const s = scenario();
  assert.equal((await s.send("reserve", {}, { origin: "https://attacker.invalid" })).status, 403);
  assert.equal(s.calls.reservations.length, 0);
});

test("missing objects, corrupted content, disguised formats, excessive sizes and caller paths never finalize", async () => {
  const missing = scenario({ missingObject: true });
  assert.equal((await missing.send()).body.errorCode, "UPLOAD-006");
  const corrupt = scenario({ bytes: Buffer.from("bad") });
  assert.equal((await corrupt.send()).body.errorCode, "UPLOAD-007");
  const bad = scenario({ bytes: Buffer.alloc(png.length) });
  assert.equal((await bad.send("finalize", { content_sha256: digest(Buffer.alloc(png.length)) })).body.errorCode, "UPLOAD-002");
  const s = scenario();
  assert.equal((await s.send("reserve", { file_size: 10485761 })).status, 400);
  assert.equal((await s.send("reserve", { storage_path: storagePath })).status, 400);
  assert.equal(s.calls.finalized.length, 0);
});

test("exact 10 MiB image is verified server-side without a large app request; JPEG disguised as PNG is rejected", async () => {
  const bytes = Buffer.concat([png, Buffer.alloc(10485760 - png.length)]);
  const s = scenario({ bytes });
  assert.equal((await s.send("finalize", { file_size: bytes.length, content_sha256: digest(bytes) })).body.success, true);
  assert.equal(s.calls.finalized[0].p_file_size, 10485760);
  const jpeg = await sharp(png).jpeg().toBuffer();
  const disguised = scenario({ bytes: jpeg });
  assert.equal((await disguised.send("finalize", { file_size: jpeg.length, content_sha256: digest(jpeg) })).body.errorCode, "UPLOAD-002");
  assert.equal(disguised.calls.finalized.length, 0);
});

test("browser sends only JSON to app Functions and uploads the file to Storage without upsert", async () => {
  const priorFetch = globalThis.fetch;
  const priorBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} });
  let posts = [], uploads = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    posts.push(body);
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.ok(Buffer.byteLength(options.body) < 4096);
    return body.action === "reserve" ? Response.json({ storage_path: storagePath }) : Response.json({ success: true });
  };
  const load = typescriptLoader();
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: participantId } }, error: null }) },
    storage: { from: () => ({ async upload(path, file, options) {
      uploads++;
      assert.equal(path, storagePath);
      assert.ok(file instanceof File);
      assert.equal(options.upsert, false);
      return { error: uploads === 1 ? null : { status: 409 } };
    } }) },
  };
  try {
    const { uploadImageDirect } = load("src/lib/images/direct-upload.ts");
    const upload = { file: new File([png], "TEST.png", { type: "image/png" }), requestId };
    assert.equal((await uploadImageDirect(client, sessionId, upload)).ok, true);
    assert.equal((await uploadImageDirect(client, sessionId, upload)).ok, true);
    assert.deepEqual(posts.map(p => p.action), ["reserve", "finalize", "reserve", "finalize"]);
    assert.equal(posts[0].content_sha256, digest(png));
    assert.equal(posts[0].request_id, posts[2].request_id);
  } finally { globalThis.fetch = priorFetch; globalThis.createImageBitmap = priorBitmap; }
});

test("browser keeps request identity after ambiguous upload, reports failures and rejects foreign reservation paths", async () => {
  const priorFetch = globalThis.fetch;
  const priorBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} });
  let phase = "lost", stored = false, finalizations = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.request_id, requestId);
    if (body.action === "finalize") { finalizations++; return Response.json({ success: true }); }
    return Response.json({ storage_path: phase === "foreign" ? `foreign/${storagePath}` : storagePath });
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: participantId } }, error: null }) },
    storage: { from: () => ({ async upload() {
      if (phase === "denied") return { error: { status: 403 } };
      if (!stored) { stored = true; throw new Error("Lost upload response; object persisted"); }
      return { error: { statusCode: "409" } };
    } }) },
  };
  try {
    const { uploadImageDirect } = typescriptLoader()("src/lib/images/direct-upload.ts");
    const upload = { file: new File([png], "TEST.png", { type: "image/png" }), requestId };
    await assert.rejects(uploadImageDirect(client, sessionId, upload), /Lost upload/);
    assert.equal(finalizations, 0);
    assert.equal((await uploadImageDirect(client, sessionId, upload)).ok, true);
    assert.equal(finalizations, 1);
    phase = "denied";
    assert.equal((await uploadImageDirect(client, sessionId, upload)).status, 503);
    assert.equal(finalizations, 1);
    phase = "foreign";
    await assert.rejects(uploadImageDirect(client, sessionId, upload), /reservation/);
    assert.equal(finalizations, 1);
  } finally { globalThis.fetch = priorFetch; globalThis.createImageBitmap = priorBitmap; }
});

test("malformed or mislabeled local images are rejected before consuming a reservation", async () => {
  const priorFetch = globalThis.fetch, priorBitmap = globalThis.createImageBitmap;
  globalThis.fetch = async () => { assert.fail("Invalid files must not reserve or upload."); };
  globalThis.createImageBitmap = async () => { throw new Error("Mock decode failure"); };
  try {
    const { uploadImageDirect } = typescriptLoader()("src/lib/images/direct-upload.ts");
    for (const file of [
      new File(["not png"], "bad.png", { type: "image/png" }),
      new File([png], "bad.jpg", { type: "image/jpeg" }),
      new File([png], "truncated.png", { type: "image/png" }),
    ]) {
      const response = await uploadImageDirect({}, sessionId, { file, requestId });
      assert.equal((await response.json()).errorCode, "UPLOAD-002");
    }
  } finally { globalThis.fetch = priorFetch; globalThis.createImageBitmap = priorBitmap; }
});
