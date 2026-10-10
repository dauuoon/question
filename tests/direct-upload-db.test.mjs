import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { initialize, owner, other, auth, quote, read } from "./question-regeneration-fixture.mjs";

const migration = read("supabase/migrations/20261010235000_verified_direct_image_upload.sql");
async function fixture() {
  const db = new PGlite();
  const exec = async sql => {
    await db.exec("reset role");
    try { return await db.exec(sql); } finally { await db.exec("reset role"); }
  };
  const json = async sql => (await exec(sql)).findLast(r => r.rows?.[0]?.result !== undefined)?.rows[0].result;
  await initialize(exec, true);
  for (const name of ["20261010002000_regeneration_dispatch_provenance.sql",
    "20261010003000_session_completion_briefing.sql"]) {
    await exec(read(`supabase/migrations/${name}`));
  }
  const session = randomUUID();
  await exec(`insert into public.sessions(id,participant_id) values(${quote(session)},${quote(owner)});`);
  await exec(migration);
  const reserve = async (id = randomUUID(), actor = owner) => ({
    id, ...await json(`${auth("authenticated", actor)} select to_jsonb(u) result from
      public.reserve_image_upload(${quote(session)},${quote(id)},'png',${quote("a".repeat(64))}) u;`),
  });

  const store = slot => exec(`${auth("authenticated")} insert into storage.objects(bucket_id,name,metadata)
    values('why-box-images',${quote(slot.storage_path)},'{"mimetype":"image/png","size":100}');`);
  const finishSQL = (slot, actor = owner, size = 100, name = "TEST.png") =>
    `select public.finish_verified_image_upload(${quote(session)},${quote(slot.id)},${quote(actor)},
      ${quote("a".repeat(64))},'image/png',${size},${quote(name)},4,4) result;`;
  const finish = (slot, actor = owner, size = 100, name = "TEST.png") =>
    json(`${auth()} ${finishSQL(slot, actor, size, name)}`);
  return { db, exec, json, session, reserve, store, finishSQL, finish };
}

test("direct upload DB gates ownership, metadata bypass, overwrite, RPC access, exact replay and capacity", async () => {
  const f = await fixture();
  try {
    const slot = await f.reserve();
    await assert.rejects(f.reserve(randomUUID(), other), /denied/);
    await f.store(slot);
    assert.equal(await f.json(`${auth("authenticated", other)} select to_jsonb(count(*)) result
      from storage.objects where name=${quote(slot.storage_path)}`), 0);
    await assert.rejects(f.exec(`${auth("authenticated", other)} insert into storage.objects(bucket_id,name,metadata)
      values('why-box-images',${quote(`${other}/${f.session}/bad.png`)},'{}')`), /row-level security/);
    assert.equal(await f.json(`${auth("authenticated")} with changed as (
      update storage.objects set metadata='{}' where name=${quote(slot.storage_path)} returning id)
      select to_jsonb(count(*)) result from changed;`), 0);
    assert.equal(await f.json(`${auth("authenticated")} with removed as (
      delete from storage.objects where name=${quote(slot.storage_path)} returning id)
      select to_jsonb(count(*)) result from removed;`), 0);
    await assert.rejects(f.exec(`${auth("authenticated")} insert into public.session_images(
      id,session_id,storage_path,original_filename,mime_type,file_size,width,height,sort_order)
      values(${quote(slot.id)},${quote(f.session)},${quote(slot.storage_path)},'TEST.png','image/png',100,4,4,0)`), /permission denied/);
    await assert.rejects(f.exec(`${auth("authenticated")} ${f.finishSQL(slot)}`), /permission denied/);
    await assert.rejects(f.finish(slot, other), /ownership/);
    await assert.rejects(f.finish(slot, owner, 101), /metadata mismatch/);
    assert.equal(await f.finish(slot), true);
    assert.equal(await f.finish(slot), false);
    await assert.rejects(f.finish(slot, owner, 100, "changed.png"), /replay mismatch/);
    await assert.rejects(f.exec(`${auth("authenticated")} update public.session_images set width=5
      where id=${quote(slot.id)}`), /permission denied/);
    for (let i = 1; i < 10; i++) await f.reserve();
    await assert.rejects(f.reserve(), /capacity exhausted/);
    assert.equal((await f.reserve(slot.id)).storage_path, slot.storage_path);
    assert.equal(await f.json(`select to_jsonb(count(*)) result from public.session_images`), 1);
  } finally { await f.db.close(); }
});

test("verified finalize rejects missing objects, inactive users and deletion tombstones without releasing reservations", async () => {
  const f = await fixture();
  try {
    const slot = await f.reserve();
    await assert.rejects(f.finish(slot), /object metadata mismatch/);
    await f.store(slot);
    await f.exec(`update public.profiles set status='deactivated' where id=${quote(owner)}`);
    await assert.rejects(f.finish(slot), /frozen or deleted/);
    await f.exec(`update public.profiles set status='active' where id=${quote(owner)}`);
    await f.finish(slot);
    await f.exec(`${auth("authenticated")} select public.begin_image_deletion(${quote(f.session)},${quote(slot.id)});`);
    await assert.rejects(f.finish(slot), /frozen or deleted/);
    await f.exec(`${auth("authenticated")} delete from storage.objects where name=${quote(slot.storage_path)};
      select public.finish_image_deletion(${quote(f.session)},${quote(slot.id)});`);
    await assert.rejects(f.reserve(slot.id), /Deleted request/);
    assert.equal(await f.json(`select to_jsonb(count(*)) result from public.image_deletions`), 1);
  } finally { await f.db.close(); }
});

test("local direct-upload migration does not rewrite research records or Storage and has a reload/permission contract", () => {
  assert.doesNotMatch(migration, /(?:insert into|update|delete from|truncate)\s+(?:storage\.(?:objects|buckets)|public\.(?:profiles|sessions|answers|diaries))\b/i);
  assert.match(migration, /revoke insert, update on public\.session_images from authenticated, anon/);
  assert.match(migration, /for update to authenticated/);
  assert.match(migration, /for update;/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
});

test("unfinalized direct objects block generation and registered images freeze against uploads after generation begins", async () => {
  const f = await fixture();
  try {
    await f.exec(`${auth("authenticated")} select public.save_session_context(${quote(f.session)},
      'ux_ui','web_design',null,'idea_concept','Local context',array['visual_form']);`);
    const first = await f.reserve();
    await f.store(first);
    await f.finish(first);
    const second = await f.reserve();
    await f.store(second);
    const generationSQL = `${auth("authenticated")} select public.begin_question_generation(
      ${quote(f.session)},${quote(randomUUID())});`;
    await assert.rejects(f.exec(generationSQL), /upload|image/i);
    await f.finish(second);
    await f.exec(generationSQL);
    await assert.rejects(f.finish(first), /frozen or deleted/);
    await assert.rejects(f.reserve(), /locked|denied/i);
    assert.equal(await f.json(`${auth("authenticated")} with changed as (
      update storage.objects set metadata='{}' where name=${quote(first.storage_path)} returning id)
      select to_jsonb(count(*)) result from changed;`), 0);
  } finally { await f.db.close(); }
});
