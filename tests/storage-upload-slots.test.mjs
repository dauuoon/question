import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { File } from "node:buffer";
import { URL } from "node:url";
import test from "node:test";
import { mapConcurrent, prepareImageUploads, unsavedImageUploads } from "../src/lib/images/upload-request.ts";
import { MAX_IMAGE_BYTES, MAX_IMAGE_COUNT, validateImageFile } from "../src/lib/images/limits.ts";

test("retries retain the same request ID and file", () => {
  const files = [
    new File(["TEST"], "TEST-a.png", { type: "image/png" }),
    new File(["TEST"], "TEST-b.jpg", { type: "image/jpeg" }),
  ];
  const uploads = prepareImageUploads(files);
  assert.equal(new Set(uploads.map((upload) => upload.requestId)).size, 2);
  assert.match(uploads[0].requestId, /^[0-9a-f-]{36}$/);
  const failedTail = uploads.slice(1);
  const retry = unsavedImageUploads(failedTail, []);
  assert.equal(retry[0], uploads[1]);
  assert.equal(retry[0].file, files[1]);
  assert.equal(retry[0].requestId, uploads[1].requestId);
});

test("upload work is concurrency-limited and preserves request order", async () => {
  let active = 0, maximum = 0;
  const results = await mapConcurrent([0, 1, 2, 3, 4], 2, async (value) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => globalThis.setTimeout(resolve, value === 0 ? 5 : 1));
    active--;
    return value * 2;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(results, [0, 2, 4, 6, 8]);
  await assert.rejects(mapConcurrent([], 0, async value => value), RangeError);
});

test("a committed upload with a lost response is excluded after reconciliation", () => {
  const uploads = prepareImageUploads([
    new File(["TEST"], "TEST-a.png", { type: "image/png" }),
    new File(["TEST"], "TEST-b.png", { type: "image/png" }),
  ]);
  assert.deepEqual(unsavedImageUploads(uploads, [uploads[0].requestId]), [uploads[1]]);
  assert.deepEqual(unsavedImageUploads(uploads, uploads.map((upload) => upload.requestId)), []);
  const lastRetry = unsavedImageUploads([uploads[0]], [uploads[0].requestId]);
  assert.equal(MAX_IMAGE_COUNT + lastRetry.length, 10);
});

test("existing exact size, type, and count constants remain unchanged", () => {
  assert.equal(MAX_IMAGE_COUNT, 10);
  assert.equal(MAX_IMAGE_BYTES, 10485760);
  assert.equal(validateImageFile(new File([new Uint8Array(MAX_IMAGE_BYTES)], "TEST.png", { type: "image/png" })), null);
  assert.equal(validateImageFile(new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "TEST.png", { type: "image/png" })), "UPLOAD-003");
  assert.equal(validateImageFile(new File(["TEST"], "TEST.jpg", { type: "image/jpeg" })), null);
  assert.equal(validateImageFile(new File(["TEST"], "TEST.jpeg", { type: "image/jpeg" })), null);
  assert.equal(validateImageFile(new File(["TEST"], "TEST.pdf", { type: "application/pdf" })), "UPLOAD-002");
});

const migration = readFileSync(new URL("../supabase/migrations/20261003233000_storage_upload_slots.sql", import.meta.url), "utf8");

test("migration is transaction-bounded with fail-closed backfill and immutable capacity", () => {
  assert.match(migration, /\bbegin;/i);
  assert.match(migration, /commit;\s*$/i);
  assert.match(migration, /lock table storage\.objects in share row exclusive mode/i);
  assert.match(migration, /having count\(\*\) > 10/i);
  assert.match(migration, /o\.id is null or i\.id is null/i);
  assert.match(migration, /primary key \(session_id, slot_index\)/i);
  assert.match(migration, /slot_index between 1 and 10/i);
  assert.match(migration, /for update of s/i);
  assert.match(migration, /Upload reservations are immutable and cannot be released/);
  assert.doesNotMatch(migration, /(?:insert into|update|delete from|truncate(?: table)?)\s+storage\.(?:objects|buckets)\b/i);
  assert.doesNotMatch(migration, /(?:drop|alter) policy/i);
});

test("restrictive policies add an AND gate and helper never queries Storage recursively", () => {
  assert.equal((migration.match(/on storage\.objects as restrictive/g) ?? []).length, 2);
  const helper = migration.split("create function public.is_reserved_image_path")[1].split("$$;")[0];
  assert.match(helper, /from public\.storage_upload_slots/i);
  assert.doesNotMatch(helper, /storage\.objects/i);
  assert.match(migration, /grant execute on function public\.reserve_image_upload\(uuid, uuid, text, text\) to authenticated/i);
  assert.doesNotMatch(migration, /grant .* to service_role/i);
});
