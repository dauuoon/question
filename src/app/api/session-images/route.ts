import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import sharp, { type Metadata } from "sharp";
import { createHash } from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/errors/report";
import {
  IMAGE_BUCKET, MAX_IMAGE_BYTES,
} from "@/lib/images/limits";
import { imageUploadRequestSchema, imageUploadPath, uploadReservationSchema } from "@/lib/images/direct-upload-contract";
import { hasSameOrigin, readJsonBody, SessionCompletionApiError } from "@/lib/session-completion/api";
import type { ErrorCode } from "@/lib/errors/catalog";
import { recordParticipantActivity } from "@/lib/activity/record";

export const runtime = "nodejs";
export const maxDuration = 120;
const deletionEnabled = () => process.env.SESSION_IMAGE_DELETION_ENABLED === "true";

async function authenticateParticipant() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error && error.name !== "AuthSessionMissingError") {
    return { response: await failure("AUTH-004", "image.auth.verify", 503, {}, error.code) };
  }
  if (!user) return { response: await failure("AUTH-002", "image.auth", 403) };
  const { data: profile, error: profileError } = await supabase.from("profiles")
    .select("role, status").eq("id", user.id).maybeSingle();
  if (profileError) {
    return { response: await failure("AUTH-004", "image.auth.profile", 503, {}, profileError.code) };
  }
  if (profile?.role !== "participant" || profile.status !== "active") {
    return { response: await failure("AUTH-002", "image.auth.role", 403) };
  }
  return { supabase, user };
}

async function failure(
  code: ErrorCode,
  operation: string,
  status: number,
  context: { participantId?: string; sessionId?: string } = {},
  internalCode?: string,
) {
  return NextResponse.json(
    await reportError(code, operation, context, internalCode),
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return failure("AUTH-002", "image.origin", 403);
  }
  const auth = await authenticateParticipant();
  if ("response" in auth) return auth.response;
  const participantContext = { participantId: auth.user.id };
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return failure("UPLOAD-002", "image.json_required", 415, participantContext);
  }
  let body: unknown;
  try {
    body = await readJsonBody(request, 4096);
  } catch (error) {
    return failure("UPLOAD-002", "image.json", error instanceof SessionCompletionApiError ? error.status : 400, participantContext);
  }
  const parsed = imageUploadRequestSchema.safeParse(body);
  if (!parsed.success) return failure("UPLOAD-007", "image.input", 400, participantContext);
  const input = parsed.data;
  const { supabase, user } = auth;
  const context = { ...participantContext, sessionId: input.session_id };
  try {
    const { data: session, error: sessionError } = await supabase.from("sessions")
      .select("status").eq("id", input.session_id).eq("participant_id", user.id).maybeSingle();
    if (sessionError || !session || !["draft", "question_generation"].includes(session.status)) {
      return failure("UPLOAD-005", "image.session", 403, participantContext, sessionError?.code);
    }
    const capability = await supabase.rpc("read_direct_image_upload_capability");
    if (capability.error || capability.data !== 1) {
      return failure("UPLOAD-001", "image.migration_required", 503, context, capability.error?.code);
    }
    const questions = await supabase.from("questions")
      .select("id", { count: "exact", head: true }).eq("session_id", input.session_id);
    if (questions.error) {
      return failure("UPLOAD-001", "image.preflight", 503, context, questions.error.code);
    }
    if ((questions.count ?? 0) > 0) return failure("UPLOAD-005", "image.frozen", 403, context);

    const extension = input.mime_type === "image/jpeg" ? "jpg" : "png";
    const { data: reserved, error: reserveError } = await supabase.rpc("reserve_image_upload", {
      p_session_id: input.session_id, p_request_id: input.request_id,
      p_extension: extension, p_content_sha256: input.content_sha256,
    });
    if (reserveError) {
      if (reserveError.code === "23514") return failure("UPLOAD-004", "image.reserve.capacity", 409, context, reserveError.code);
      if (reserveError.code === "42501") return failure("UPLOAD-005", "image.reserve.access", 403, context, reserveError.code);
      if (reserveError.code === "22023") return failure("UPLOAD-007", "image.reserve.input", 409, context, reserveError.code);
      return failure("UPLOAD-001", "image.reserve", 503, context, reserveError.code);
    }
    const reservation = uploadReservationSchema.safeParse(reserved);
    const expectedPath = imageUploadPath(user.id, input);
    if (!reservation.success || reservation.data[0].storage_path !== expectedPath) {
      return failure("UPLOAD-007", "image.reserve.result", 503, context);
    }
    const { storage_path: storagePath } = reservation.data[0];
    if (input.action === "reserve") {
      return NextResponse.json({ storage_path: storagePath }, { headers: { "Cache-Control": "no-store" } });
    }
    const { data: existingObject, error: readError } = await supabase.storage.from(IMAGE_BUCKET).download(storagePath);
    if (readError || !existingObject) return failure("UPLOAD-006", "image.reconcile.object", 503, context);
    if (existingObject.size !== input.file_size || existingObject.size > MAX_IMAGE_BYTES) {
      return failure("UPLOAD-007", "image.reconcile.content_mismatch", 409, context);
    }
    const buffer = Buffer.from(await existingObject.arrayBuffer());
    if (createHash("sha256").update(buffer).digest("hex") !== input.content_sha256) {
      return failure("UPLOAD-007", "image.reconcile.content_mismatch", 409, context);
    }
    let metadata: Metadata;
    try {
      metadata = await sharp(buffer).metadata();
      await sharp(buffer).timeout({ seconds: 15 }).stats();
    } catch {
      return failure("UPLOAD-002", "image.decode", 400, context);
    }
    const actualMime = metadata.format === "jpeg" ? "image/jpeg" : metadata.format === "png" ? "image/png" : null;
    if (actualMime !== input.mime_type || !metadata.width || !metadata.height) {
      return failure("UPLOAD-002", "image.format", 400, context);
    }
    // Browser writes cannot finalize metadata; the trusted RPC rechecks state under the parent lock.
    const finished = await createSupabaseAdminClient().rpc("finish_verified_image_upload", {
      p_session_id: input.session_id, p_request_id: input.request_id, p_participant_id: user.id,
      p_content_sha256: input.content_sha256, p_mime_type: actualMime,
      p_file_size: buffer.length, p_original_filename: input.original_filename,
      p_width: metadata.width, p_height: metadata.height,
    });
    if (finished.error || typeof finished.data !== "boolean") {
      if (finished.error?.code === "42501") return failure("UPLOAD-005", "image.finish.access", 403, context);
      if (finished.error?.code === "22023") return failure("UPLOAD-007", "image.finish.mismatch", 409, context);
      return failure("UPLOAD-006", "image.metadata.reservation_retained", 503, context, finished.error?.code);
    }
    const activityRecorded = !finished.data || await recordParticipantActivity("image_uploaded");
    return NextResponse.json({ success: true, activityRecorded }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return failure("UPLOAD-006", "image.network.reservation_retained", 503, context);
  }
}

export async function GET(request: NextRequest) {
  const auth = await authenticateParticipant();
  if ("response" in auth) return auth.response;
  const sessionId = z.uuid().safeParse(request.nextUrl.searchParams.get("session_id"));
  if (!sessionId.success) return failure("UPLOAD-005", "image.list.input", 400);
  const participantContext = { participantId: auth.user.id };
  const { data: session, error: sessionError } = await auth.supabase.from("sessions")
    .select("id").eq("id", sessionId.data).eq("participant_id", auth.user.id).maybeSingle();
  if (sessionError || !session) return failure("UPLOAD-005", "image.list.session", 403, participantContext, sessionError?.code);
  const context = { ...participantContext, sessionId: sessionId.data };
  const { data, error } = await auth.supabase.from("session_images")
    .select("id, original_filename, storage_path, sort_order")
    .eq("session_id", sessionId.data).order("sort_order");
  if (error) return failure("UPLOAD-001", "image.list.metadata", 503, context, error.code);
  const pending = new Set<string>();
  if (deletionEnabled()) {
    const jobs = await auth.supabase.from("image_deletions").select("image_id")
      .eq("session_id", sessionId.data).is("completed_at", null);
    if (jobs.error) return failure("UPLOAD-008", "image.list.deletions", 503, context, jobs.error.code);
    for (const job of jobs.data ?? []) pending.add(job.image_id);
  }
  const result = [];
  for (const image of data ?? []) {
    if (pending.has(image.id)) {
      result.push({ id: image.id, original_filename: image.original_filename,
        sort_order: image.sort_order, previewUrl: null, deletionPending: true });
      continue;
    }
    const { data: signed, error: signedError } = await auth.supabase.storage
      .from(IMAGE_BUCKET).createSignedUrl(image.storage_path, 300);
    if (signedError || !signed) return failure("UPLOAD-001", "image.list.preview", 503, context);
    result.push({
      id: image.id, original_filename: image.original_filename,
      sort_order: image.sort_order, previewUrl: signed.signedUrl,
    });
  }
  return NextResponse.json({ images: result, deletionEnabled: deletionEnabled() },
    { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: NextRequest) {
  const protocol = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.slice(0, -1);
  if (!request.headers.get("host") ||
    request.headers.get("origin") !== `${protocol}://${request.headers.get("host")}`) {
    return failure("AUTH-002", "image.delete.origin", 403);
  }
  const auth = await authenticateParticipant();
  if ("response" in auth) return auth.response;
  if (!deletionEnabled()) return failure("UPLOAD-009", "image.delete.disabled", 409);
  const sessionId = z.uuid().safeParse(request.nextUrl.searchParams.get("session_id"));
  const imageId = z.uuid().safeParse(request.nextUrl.searchParams.get("image_id"));
  if (!sessionId.success || !imageId.success) return failure("UPLOAD-009", "image.delete.input", 400);
  const context = { participantId: auth.user.id, sessionId: sessionId.data };
  const parameters = { p_session_id: sessionId.data, p_image_id: imageId.data };
  try {
    const claim = await auth.supabase.rpc("begin_image_deletion", parameters);
    if (claim.error) return failure(claim.error.code === "42501" ? "UPLOAD-009" : "UPLOAD-008",
      "image.delete.begin", claim.error.code === "42501" ? 403 : 503, context, claim.error.code);
    const parsed = z.array(z.object({ storage_path: z.string(), completed: z.boolean() })).length(1).safeParse(claim.data);
    if (!parsed.success || !parsed.data[0].storage_path.startsWith(`${auth.user.id}/${sessionId.data}/`)) {
      return failure("UPLOAD-008", "image.delete.claim_result", 503, context);
    }
    if (parsed.data[0].completed) {
      return NextResponse.json({ success: true, changed: false, activityRecorded: true },
        { headers: { "Cache-Control": "no-store" } });
    }
    const removed = await auth.supabase.storage.from(IMAGE_BUCKET).remove([parsed.data[0].storage_path]);
    if (removed.error) return failure("UPLOAD-008", "image.delete.storage", 503, context);
    // PostgreSQL independently verifies the object is absent before releasing capacity.
    const finished = await auth.supabase.rpc("finish_image_deletion", parameters);
    if (finished.error || typeof finished.data !== "boolean") {
      return failure("UPLOAD-008", "image.delete.finish", 503, context, finished.error?.code);
    }
    const activityRecorded = !finished.data || await recordParticipantActivity("image_deleted");
    return NextResponse.json({ success: true, changed: finished.data, activityRecorded },
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return failure("UPLOAD-008", "image.delete.network", 503, context);
  }
}
