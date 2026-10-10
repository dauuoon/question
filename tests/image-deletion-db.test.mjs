import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const owner = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const session = "20000000-0000-4000-8000-000000000001";
const digest = "a".repeat(64);
const read = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema extensions;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as
      $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
    create function auth.role() returns text language sql as
      $$select current_setting('request.jwt.claim.role', true)$$;
    grant usage on schema auth, storage to authenticated;
    grant execute on all functions in schema auth to authenticated;
    create table storage.buckets(id text primary key, name text, public boolean,
      file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text,
      metadata jsonb, unique(bucket_id, name));
    alter table storage.objects enable row level security;
    grant select, insert, update, delete on storage.objects to authenticated;
    create function storage.foldername(name text) returns text[] language sql immutable as
      $$select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1)-1]$$;
  `);
  // gen_random_uuid is built into PostgreSQL; hosted pgcrypto installation is not needed here.
  await db.exec(read("20261003201500_phase1_schema.sql").replace(
    "create extension if not exists pgcrypto with schema extensions;", ""));
  for (const name of ["20261003201600_phase1_rls.sql", "20261003233000_storage_upload_slots.sql",
    "20261004150000_participant_last_activity.sql", "20261005190000_session_context_save.sql",
    "20261005231000_context_draft_claim.sql"]) await db.exec(read(name));
  await db.exec(read("20261006031000_image_deletion.sql"));
  await db.exec(`insert into auth.users values ('${owner}'), ('${other}');
    insert into public.profiles(id, participant_code) values ('${owner}', 'P99001'), ('${other}', 'P99002');
    insert into public.sessions(id, participant_id) values ('${session}', '${owner}');`);
  const asUser = async (id, operation) => {
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${id}', false);`);
    try { return await operation(); } finally { await db.exec("reset role"); }
  };
  const query = async (sql, params = [], id = owner) => asUser(id, () => db.query(sql, params));
  const upload = async (n) => {
    const id = `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const reserved = await query("select * from public.reserve_image_upload($1,$2,'png',$3)", [session, id, digest]);
    const slot = reserved.rows[0];
    await query(`insert into storage.objects(bucket_id,name,metadata) values ('why-box-images',$1,
      '{"mimetype":"image/png","size":100}')`, [slot.storage_path]);
    await query(`insert into public.session_images(id,session_id,storage_path,original_filename,mime_type,
      file_size,width,height,sort_order) values ($1,$2,$3,'TEST.png','image/png',100,4,4,$4)`,
    [id, session, slot.storage_path, slot.sort_order]);
    return { id, ...slot };
  };
  const begin = (image, id = owner) => query("select * from public.begin_image_deletion($1,$2)", [session, image.id], id);
  const finish = (image, id = owner) => query("select public.finish_image_deletion($1,$2) changed", [session, image.id], id);
  const remove = (image) => query("delete from storage.objects where bucket_id='why-box-images' and name=$1", [image.storage_path]);
  return { db, query, upload, begin, finish, remove };
}

test("local PostgreSQL: complete existing migrations, full-capacity delete/reuse, ordering and replay", async () => {
  const f = await fixture();
  try {
    const images = [];
    for (let i = 1; i <= 10; i++) images.push(await f.upload(i));
    await assert.rejects(f.upload(11), /capacity exhausted/);
    await f.begin(images[4]);
    await assert.rejects(f.finish(images[4]), /Storage deletion not confirmed/);
    assert.equal((await f.db.query("select count(*)::int n from public.storage_upload_slots")).rows[0].n, 10);
    await f.remove(images[4]);
    assert.equal((await f.finish(images[4])).rows[0].changed, true);
    assert.equal((await f.finish(images[4])).rows[0].changed, false);
    const replay = await f.begin(images[4]);
    assert.equal(replay.rows[0].completed, true);
    const replacement = await f.upload(11);
    assert.equal(replacement.slot_index, images[4].slot_index);
    assert.equal(replacement.sort_order, 10);
    const remaining = (await f.db.query("select id,sort_order from public.session_images order by sort_order")).rows;
    assert.deepEqual(remaining.map((row) => row.sort_order), [0, 1, 2, 3, 5, 6, 7, 8, 9, 10]);
    await assert.rejects(f.query("select * from public.reserve_image_upload($1,$2,'png',$3)",
      [session, images[4].id, digest]), /Deleted request/);
    await assert.rejects(f.query("insert into storage.objects(bucket_id,name) values ('why-box-images',$1)",
      [images[4].storage_path]), /row-level security/);
    const counts = await f.db.query(`select
      (select count(*)::int from public.session_images) images,
      (select count(*)::int from public.storage_upload_slots) slots,
      (select count(*)::int from storage.objects) objects,
      (select count(*)::int from public.image_deletions where completed_at is not null) tombstones`);
    assert.deepEqual(counts.rows[0], { images: 10, slots: 10, objects: 10, tombstones: 1 });
  } finally { await f.db.close(); }
});

test("local PostgreSQL: ownership/inactivity, pending freeze, Storage failure retention and transaction rollback", async () => {
  const f = await fixture();
  try {
    const image = await f.upload(1);
    await assert.rejects(f.begin(image, other), /denied/);
    await assert.rejects(f.query("delete from public.session_images where id=$1", [image.id]), /Storage/);
    await f.db.exec(`update public.profiles set status='deactivated' where id='${owner}'`);
    await assert.rejects(f.begin(image), /denied/);
    await f.db.exec(`update public.profiles set status='active' where id='${owner}'`);
    await f.begin(image);
    await f.begin(image);
    await assert.rejects(f.query("update public.sessions set status='in_progress' where id=$1", [session]), /Pending image deletion/);
    await assert.rejects(f.upload(2), /pending image deletion/);
    await assert.rejects(f.query("update public.session_images set original_filename='changed.png' where id=$1",
      [image.id]), /cannot be rewritten/);
    assert.equal((await f.db.query("select count(*)::int n from storage.objects")).rows[0].n, 1);
    await f.remove(image);
    await f.db.exec("begin");
    assert.equal((await f.finish(image)).rows[0].changed, true);
    await f.db.exec("rollback");
    assert.equal((await f.db.query("select count(*)::int n from public.session_images")).rows[0].n, 1);
    assert.equal((await f.db.query("select count(*)::int n from public.storage_upload_slots")).rows[0].n, 1);
    assert.equal((await f.db.query("select completed_at from public.image_deletions")).rows[0].completed_at, null);
    assert.equal((await f.finish(image)).rows[0].changed, true);
    // Context autosave and immutable auto-claim marker remain usable after deletion.
    assert.equal((await f.query(`select public.save_session_context($1,'ux_ui','web_design',null,
      'idea_concept','TEST',array['visual_form']) changed`, [session])).rows[0].changed, true);
  } finally { await f.db.close(); }
});

test("local PostgreSQL: questions block new deletion, and pending deletion blocks question insertion", async () => {
  const f = await fixture();
  try {
    const image = await f.upload(1);
    const qid = "40000000-0000-4000-8000-000000000001";
    await f.db.exec(`update public.sessions set status='question_generation' where id='${session}'`);
    const sql = `insert into public.questions(id,session_id,root_question_id,question_kind,slot_index,regeneration_index,
      question_text,target_type,selection_reason,model_id,prompt_version,framework_version,generated_at)
      values ('${qid}','${session}','${qid}','original',1,0,'TEST','image','TEST','TEST','TEST','TEST',now())`;
    await f.begin(image);
    await assert.rejects(f.db.exec(sql), /Pending image deletion/);
    await f.remove(image); await f.finish(image);
    const replacement = await f.upload(2);
    await f.db.exec(`begin; ${sql};
      insert into public.question_targets(question_id,session_id,image_id)
        values ('${qid}','${session}','${replacement.id}'); commit;`);
    await assert.rejects(f.begin({ id: "30000000-0000-4000-8000-000000000002" }), /denied/);
  } finally { await f.db.close(); }
});

test("local PostgreSQL: legacy backfill image/request mismatch cannot resurrect, and participants cannot release slots", async () => {
  const f = await fixture();
  try {
    const image = await f.upload(1);
    const legacyImageId = "30000000-0000-4000-8000-000000000099";
    // The backfill uses independent reservation UUIDs. Reproduce that shape with a fresh image.
    const slot = (await f.query("select * from public.reserve_image_upload($1,$2,'png',$3)",
      [session, "30000000-0000-4000-8000-000000000002", digest])).rows[0];
    await f.query(`insert into storage.objects(bucket_id,name,metadata) values ('why-box-images',$1,
      '{"mimetype":"image/png","size":100}')`, [slot.storage_path]);
    await f.query(`insert into public.session_images(id,session_id,storage_path,original_filename,mime_type,
      file_size,width,height,sort_order) values ($1,$2,$3,'LEGACY.png','image/png',100,4,4,$4)`,
    [legacyImageId, session, slot.storage_path, slot.sort_order]);
    const legacy = { id: legacyImageId, ...slot };
    await f.begin(legacy); await f.remove(legacy); await f.finish(legacy);
    await assert.rejects(f.query("select * from public.reserve_image_upload($1,$2,'png',$3)",
      [session, legacyImageId, digest]), /Deleted request/);
    await assert.rejects(f.query("delete from public.storage_upload_slots where session_id=$1", [session]),
      /permission denied/);
    await assert.rejects(f.query("update public.image_deletions set completed_at=null"), /permission denied/);
    const directDelete = await f.query("delete from storage.objects where name=$1 returning name", [image.storage_path]);
    assert.equal(directDelete.rows.length, 0);
    assert.equal((await f.db.query("select count(*)::int n from storage.objects")).rows[0].n, 1);
  } finally { await f.db.close(); }
});
