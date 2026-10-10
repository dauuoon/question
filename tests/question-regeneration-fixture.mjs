import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { PGlite } from "@electric-sql/pglite";

export const owner = "10000000-0000-4000-8000-000000000001";
export const other = "10000000-0000-4000-8000-000000000002";
export const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
export const catalog = read("tests/question-generation-db.test.mjs").match(/await db.exec\(`([\s\S]*?)`\);/)[1];
export const migrations = [
  "20261003201500_phase1_schema.sql", "20261003201600_phase1_rls.sql",
  "20261003233000_storage_upload_slots.sql", "20261004150000_participant_last_activity.sql",
  "20261005190000_session_context_save.sql", "20261005231000_context_draft_claim.sql",
  "20261006031000_image_deletion.sql", "20261008031500_question_generation_foundation.sql",
  "20261008220000_answer_refinement_version.sql", "20261009002000_question_actions.sql",
  "20261010001500_question_regeneration.sql",
];
export const generatedAt = "2026-10-09T15:00:00Z";
export const quote = (value) => value === null ? "null" : `'${String(value).replaceAll("'", "''")}'`;
export const auth = (role = "service_role", actor = owner) =>
  `set role ${role}; select set_config('request.jwt.claim.sub',${quote(actor)},false),
    set_config('request.jwt.claim.role',${quote(role)},false);`;
export const candidate = (text = "A fresh API perspective?") => ({
  candidate_rank: 1, question_text: text, content_principle: "사고의 자각과 외재화", question_type: "자기인식 질문",
  related_contexts: ["visual_form"], answer_guides: ["Consider another angle"],
  target: { type: "region", image_indices: [2], region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
});
export const initialCandidates = () => Array.from({ length: 5 }, (_, i) => ({
  ...candidate(`Initial question ${i + 1}?`), candidate_rank: i + 1,
  target: { type: "image", image_indices: [1], region: null },
}));

// Adapter works with PGlite and independent native psql connections.
export async function initialize(exec, pglite = false) {
  await exec(catalog);
  for (const file of migrations) {
    let sql = read(`supabase/migrations/${file}`);
    if (pglite) sql = sql.replace("create extension if not exists pgcrypto with schema extensions;", "");
    await exec(sql);
  }
  await exec(`insert into auth.users values(${quote(owner)}),(${quote(other)});
    insert into public.profiles(id,participant_code) values(${quote(owner)},'P99001'),(${quote(other)},'P99002');`);
}
export async function populate(exec, json, count = 5) {
  const session = randomUUID();
  const request = randomUUID();
  await exec(`insert into public.sessions(id,participant_id,requested_question_count)
    values(${quote(session)},${quote(owner)},${count});`);
  await exec(`${auth("authenticated")} select public.save_session_context(${quote(session)},
    'ux_ui','web_design',null,'idea_concept','Local mock context',array['visual_form']);`);
  const images = [];
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    const slot = await json(`${auth("authenticated")} select to_jsonb(u) as result from
      public.reserve_image_upload(${quote(session)},${quote(id)},'png',${quote("a".repeat(64))}) u;`);
    await exec(`${auth("authenticated")} insert into storage.objects(bucket_id,name,metadata)
      values('why-box-images',${quote(slot.storage_path)},'{"mimetype":"image/png","size":100}');
      insert into public.session_images(id,session_id,storage_path,original_filename,mime_type,file_size,width,height,sort_order)
      values(${quote(id)},${quote(session)},${quote(slot.storage_path)},'local.png','image/png',100,800,600,${slot.sort_order});`);
    images.push(id);
  }
  const attempt = await json(`${auth("authenticated")} select public.begin_question_generation(${quote(session)},${quote(request)}) as result;`);
  await exec(`${auth()} select public.stage_question_generation_candidates(${quote(attempt.attempt_id)},${quote(request)},
    ${quote(JSON.stringify(initialCandidates()))}::jsonb,'LOCAL-MOCK','question-generation-v2.5',
    'why_box_question_generation_v2_0','v1.0',${quote(generatedAt)});
    select public.commit_question_generation(${quote(attempt.attempt_id)},${quote(request)});`);
  const questions = await json(`select jsonb_agg(to_jsonb(q) order by q.slot_index) as result
    from public.questions q where session_id=${quote(session)} and is_active_version;`);
  return { session, images, questions };
}
export const beginSQL = (f, q = f.questions[0], request = randomUUID(), revision = null, allow = true) =>
  `${auth()} select public.begin_question_regeneration(${quote(f.session)},${quote(q.id)},${quote(request)},
    ${quote(owner)},${quote(revision)},${allow}) as result;`;
export const dispatchSQL = (r) => `${auth()} select public.authorize_question_regeneration_dispatch(
  ${quote(r.attempt_id)},${quote(r.request_id)},${quote(owner)}) as result;`;
export const stageSQL = (r, payload = candidate()) => `${auth()} select public.stage_question_regeneration_candidate(
  ${quote(r.attempt_id)},${quote(r.request_id)},${quote(owner)},${quote(JSON.stringify(payload))}::jsonb,
  'LOCAL-MOCK','question-regeneration-v1.0','why_box_question_regeneration_v1_0','v1.0',${quote(generatedAt)}) as result;`;
export const commitSQL = (r) => `${auth()} select public.commit_question_regeneration(
  ${quote(r.attempt_id)},${quote(r.request_id)},${quote(owner)}) as result;`;
export const failSQL = (r, code = "QR-API", unknown = false) => `${auth()} select public.fail_question_regeneration(
  ${quote(r.attempt_id)},${quote(r.request_id)},${quote(owner)},${quote(code)},${unknown}) as result;`;
export const recoverSQL = (r) => `${auth()} select public.recover_question_regeneration(
  ${quote(r.attempt_id)},${quote(r.request_id)},${quote(owner)}) as result;`;
export const answerSQL = (q, text = "A written answer") => `${auth("authenticated")}
  insert into public.answers(question_id,participant_id,original_answer) values(${quote(q.id)},${quote(owner)},${quote(text)});`;
export const completeSQL = (f) => `${auth()}
  update public.sessions set status='summary_ready' where id=${quote(f.session)};
  update public.sessions set status='completed',summary_text='Local test summary' where id=${quote(f.session)};`;
export const pinsSQL = (f) => `select jsonb_agg(to_jsonb(q) order by q.id) as result from public.questions q where session_id=${quote(f.session)};`;
export const targetsSQL = (f) => `select jsonb_agg(to_jsonb(t) order by t.id) as result from public.question_targets t where session_id=${quote(f.session)};`;
export const expireSQL = (r, dispatched = false) => `reset role;
  alter table public.question_regeneration_attempts disable trigger question_regeneration_attempts_history;
  update public.question_regeneration_attempts set ${dispatched ? "dispatch_expires_at" : "reserved_expires_at"}=clock_timestamp()-interval '1 second'
    where id=${quote(r.attempt_id)};
  alter table public.question_regeneration_attempts enable trigger question_regeneration_attempts_history;`;
export async function pgliteFixture(count = 5) {
  const db = new PGlite();
  const exec = async (sql) => {
    await db.exec("reset role");
    try { return await db.exec(sql); }
    finally { await db.exec("reset role"); }
  };
  const json = async (sql) => {
    const result = await exec(sql);
    return result.findLast((r) => r.rows?.[0]?.result !== undefined)?.rows[0].result;
  };
  await initialize(exec, true);
  const f = await populate(exec, json, count);
  return { ...f, db, exec, json, close: () => db.close() };
}
