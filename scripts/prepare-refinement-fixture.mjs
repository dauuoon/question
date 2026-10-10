import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import process from "node:process";
import console from "node:console";
import { testRuntimeEnvironment, TEST_REF } from "./test-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const path = resolve(root, ".test-runtime/researcher-refinement.json");
const loginPath = resolve(root, ".test-runtime/researcher-refinement-login.txt");
const resume = process.argv.includes("--resume-auth-created");
if (!process.argv.includes("--create") && !resume) throw new Error("Explicit --create is required; no automatic provisioning.");
if (existsSync(path) && !resume) throw new Error("Fixture manifest already exists; inspect it instead of creating another fixture.");
const env = testRuntimeEnvironment(parseEnv(readFileSync(resolve(root, ".env.storage-test.local"), "utf8")), {});
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, options);
const caller = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, options);
const manifest = resume ? JSON.parse(readFileSync(path, "utf8")) : {
  projectRef: TEST_REF, purpose: "researcher-synthetic-sentence-refinement",
  participantCode: `P99${Date.now()}`, participantId: null, sessionId: null,
  questionIds: [], callLimit: 3, enabled: false, stage: "preflight", createdAt: new Date().toISOString(),
};
if (resume && (manifest.projectRef !== TEST_REF || manifest.stage !== "failed:auth_created" ||
    !manifest.participantId || manifest.sessionId)) throw new Error("Unsupported resume state");
mkdirSync(resolve(root, ".test-runtime"), { recursive: true, mode: 0o700 });
function save() { writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 }); }
async function checked(label, operation) {
  const result = await operation;
  if (result.error) throw new Error(`${label}: ${result.error.code ?? result.error.status ?? "error"}`);
  return result.data;
}
const tables = ["profiles", "sessions", "questions", "answers", "session_images", "question_targets"];
async function baseline() {
  const result = {};
  for (const table of tables) {
    const rows = await checked(`read ${table}`, admin.from(table).select("*").order("id"));
    result[table] = rows;
  }
  return result;
}
const digest = rows => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
try {
  const schemaResponse = await globalThis.fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, Accept: "application/openapi+json" },
    signal: globalThis.AbortSignal.timeout(15000),
  });
  if (!schemaResponse.ok) throw new Error(`TEST schema preflight HTTP ${schemaResponse.status}`);
  const schema = await schemaResponse.json();
  for (const rpc of ["save_session_context", "reserve_image_upload", "begin_question_generation",
    "stage_question_generation_candidates", "commit_question_generation", "read_question_action_capabilities"]) {
    if (!schema.paths?.[`/rpc/${rpc}`]) throw new Error(`Required TEST RPC not exposed: ${rpc}`);
  }
  const before = await baseline();
  const duplicate = before.profiles.some(row => row.participant_code === manifest.participantCode);
  if (duplicate && !resume) throw new Error("Synthetic participant code collision");
  const password = resume ? readFileSync(loginPath, "utf8").match(/Temporary password: (.+)/)?.[1] :
    randomBytes(24).toString("base64url");
  if (!password) throw new Error("Fixture password is unavailable");
  const email = `${manifest.participantCode.toLowerCase()}@participants.whybox.invalid`;
  save();
  if (!resume) {
  const user = await checked("create synthetic Auth user", admin.auth.admin.createUser({
    email, password, email_confirm: true,
    app_metadata: { why_box_fixture: manifest.purpose, project_ref: TEST_REF },
    user_metadata: { synthetic: true, fixture_purpose: manifest.purpose },
  }));
  manifest.participantId = user.user.id;
  manifest.stage = "auth_created";
  save();
  writeFileSync(loginPath, `TEST only: http://localhost:3001/login\nParticipant code: ${manifest.participantCode}\nTemporary password: ${password}\nPurpose: ${manifest.purpose}\n`, { mode: 0o600, flag: "wx" });
  await checked("create synthetic profile", admin.from("profiles").insert({
    id: manifest.participantId, participant_code: manifest.participantCode, role: "participant", status: "active",
  }));
  }
  await checked("normal participant login", caller.auth.signInWithPassword({ email, password }));
  const session = { id: randomUUID() };
  // Match the app: INSERT RETURNING cannot use ownership SELECT before the row is persisted.
  await checked("create own draft via RLS", caller.from("sessions").insert({
    id: session.id, participant_id: manifest.participantId, requested_question_count: 3,
  }));
  manifest.sessionId = session.id;
  manifest.stage = "draft_created";
  save();
  await checked("save synthetic context via RPC", caller.rpc("save_session_context", {
    p_session_id: session.id, p_primary_category_id: "ux_ui", p_subcategory_id: "web_design",
    p_other_category_text: null, p_stage_id: "idea_concept",
    p_additional_context: "연구자 문장 다듬기 기능 검증용 synthetic 화면. 실제 연구 자료가 아닙니다.",
    p_context_ids: ["visual_form"],
  }));
  const image = await sharp({ create: { width: 800, height: 600, channels: 3,
    background: { r: 248, g: 235, b: 220 } } }).png().toBuffer();
  const imageId = randomUUID();
  const slots = await checked("reserve synthetic image", caller.rpc("reserve_image_upload", {
    p_session_id: session.id, p_request_id: imageId, p_extension: "png",
    p_content_sha256: createHash("sha256").update(image).digest("hex"),
  }));
  if (!slots?.[0]?.storage_path) throw new Error("Unexpected upload reservation contract");
  const slot = slots[0];
  manifest.storagePath = slot.storage_path;
  manifest.stage = "image_reserved";
  save();
  await checked("upload new synthetic image via RLS", caller.storage.from("why-box-images")
    .upload(slot.storage_path, image, { contentType: "image/png", upsert: false }));
  await checked("register synthetic image via RLS", caller.from("session_images").insert({
    id: imageId, session_id: session.id, storage_path: slot.storage_path,
    original_filename: "researcher-synthetic.png", mime_type: "image/png", file_size: image.length,
    width: 800, height: 600, sort_order: slot.sort_order,
  }));
  const requestId = randomUUID();
  const attempt = await checked("begin synthetic generation", caller.rpc("begin_question_generation", {
    p_session_id: session.id, p_request_id: requestId,
  }));
  if (!attempt?.attempt_id) throw new Error("Unexpected generation begin contract");
  manifest.attemptId = attempt.attempt_id;
  manifest.stage = "generation_started";
  save();
  const texts = ["이 화면의 버튼 배치 방향을 어떻게 생각하고 있나요?",
    "색상 방향에 대해 현재 어떤 생각을 갖고 있나요?", "현재 선택한 표현 방식의 이유는 무엇인가요?",
    "화면에서 전달하려는 내용은 무엇인가요?", "아직 정하지 못한 부분은 무엇인가요?"];
  const candidates = texts.map((question_text, index) => ({
    candidate_rank: index + 1, question_text, content_principle: "사고의 자각과 외재화",
    question_type: "자기인식 질문", related_contexts: ["visual_form"],
    answer_guides: ["현재 생각을 자유롭게 작성하세요."],
    target: { type: "image", image_indices: [1], region: null },
  }));
  await checked("stage synthetic candidates without AI", admin.rpc("stage_question_generation_candidates", {
    p_attempt_id: attempt.attempt_id, p_request_id: requestId, p_candidates: candidates,
    p_model_id: "WHY-BOX-SYNTHETIC-FIXTURE", p_prompt_version: "question-generation-v2.5",
    p_schema_version: "why_box_question_generation_v2_0", p_framework_version: "v1.0",
    p_generated_at: new Date().toISOString(),
  }));
  await checked("commit synthetic candidates", admin.rpc("commit_question_generation", {
    p_attempt_id: attempt.attempt_id, p_request_id: requestId,
  }));
  const questions = await checked("read own active questions", caller.from("questions")
    .select("id,slot_index").eq("session_id", session.id).eq("is_active_version", true).order("slot_index"));
  if (questions.length !== 3) throw new Error("Expected exactly three synthetic active questions");
  manifest.questionIds = questions.map(row => row.id);
  const answers = ["버튼이 많아 보여서 무엇을 먼저 눌러야 할지 헷갈릴 것 같아요. 줄이면 기능을 찾기 어려울 수도 있어서 아직 고민 중이에요.",
    "색상은 아직 잘 모르겠어서 고민 중이다.", "그냥 예뻐 보여서 이렇게 했다."];
  await checked("insert synthetic answers via RLS", caller.from("answers").insert(questions.map((row, i) => ({
    question_id: row.id, participant_id: manifest.participantId, original_answer: answers[i],
  }))));
  const after = await baseline();
  const unchanged = tables.every(table => {
    const ids = new Set(before[table].map(row => row.id));
    return digest(before[table]) === digest(after[table].filter(row => ids.has(row.id)));
  });
  if (!unchanged) throw new Error("Existing data baseline changed; inspect concurrent changes before proceeding");
  const own = await checked("verify own session", caller.from("sessions")
    .select("id,status,participant_id").eq("id", session.id).single());
  if (own.status !== "in_progress" || own.participant_id !== manifest.participantId) throw new Error("Fixture ownership/state mismatch");
  manifest.stage = "ready";
  manifest.existingRowsUnchanged = unchanged;
  manifest.baselineCounts = Object.fromEntries(tables.map(table => [table, before[table].length]));
  manifest.afterCounts = Object.fromEntries(tables.map(table => [table, after[table].length]));
  save();
  console.log(JSON.stringify({ projectRef: TEST_REF, participantCode: manifest.participantCode,
    sessionId: session.id, questionCount: questions.length, existingRowsUnchanged: unchanged,
    stage: manifest.stage, callLimit: 3, enabled: false, loginPath }, null, 2));
} catch (error) {
  manifest.stage = `failed:${manifest.stage}`;
  save();
  console.error(error.message);
  console.error("Partial fixture is recorded; no existing data was cleaned up or retried automatically.");
  process.exitCode = 1;
}
