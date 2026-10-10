import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DraftError, type DraftRequest } from "../context-draft-contract";
import { IMAGE_BUCKET } from "../../images/limits";
import { DRAFT_SIGNED_URL_SECONDS } from "./config";

export async function verifyDraftSession(supabase: SupabaseClient, sessionId: string, userId: string) {
  const session = await supabase.from("sessions").select("status, additional_context")
    .eq("id", sessionId).eq("participant_id", userId).maybeSingle();
  if (session.error) throw new DraftError("DRAFT-DB", 503);
  if (!session.data || !["draft", "question_generation"].includes(session.data.status)) {
    throw new DraftError("DRAFT-AUTH", 403);
  }
  const questions = await supabase.from("questions").select("id", { count: "exact", head: true }).eq("session_id", sessionId);
  if (questions.error || questions.count === null) throw new DraftError("DRAFT-DB", 503);
  if (questions.count > 0) throw new DraftError("DRAFT-AUTH", 403);
  return session.data;
}

export async function prepareDraft(
  supabase: SupabaseClient, userId: string, request: DraftRequest,
): Promise<string[] | null> {
  await verifyDraftSession(supabase, request.session_id, userId);
  if (process.env.SESSION_IMAGE_DELETION_ENABLED === "true") {
    const pending = await supabase.from("image_deletions").select("image_id")
      .eq("session_id", request.session_id).is("completed_at", null);
    if (pending.error) throw new DraftError("DRAFT-DB", 503);
    if (pending.data?.length) throw new DraftError("DRAFT-IMAGE", 409);
  }
  const images = await supabase.from("session_images").select("id, storage_path, sort_order")
    .eq("session_id", request.session_id).order("sort_order", { ascending: true });
  if (images.error) throw new DraftError("DRAFT-IMAGE", 503);
  if (!images.data || images.data.length < 1 || images.data.length > 10) throw new DraftError("DRAFT-INPUT", 400);
  const input = request.input;
  const claim = await supabase.rpc("claim_context_draft", {
    p_session_id: request.session_id, p_manual: request.mode === "manual",
    p_primary_category_id: input.primary_category_id, p_subcategory_id: input.subcategory_id,
    p_other_category_text: input.other_category_text, p_stage_id: input.stage_id, p_context_ids: input.context_ids,
  });
  if (claim.error) {
    if (claim.error.code === "42501") throw new DraftError("DRAFT-AUTH", 403);
    if (claim.error.code === "22023") throw new DraftError("DRAFT-INPUT", 400);
    throw new DraftError("DRAFT-DB", 503);
  }
  if (claim.data === false) return null;
  if (claim.data !== true) throw new DraftError("DRAFT-DB", 503);
  const urls: string[] = [];
  for (const image of images.data) {
    const path = image.storage_path;
    if (typeof path !== "string" || !path.startsWith(`${userId}/${request.session_id}/`)) {
      throw new DraftError("DRAFT-IMAGE", 503);
    }
    const signed = await supabase.storage.from(IMAGE_BUCKET).createSignedUrl(path, DRAFT_SIGNED_URL_SECONDS);
    if (signed.error || !signed.data?.signedUrl) throw new DraftError("DRAFT-IMAGE", 503);
    urls.push(signed.data.signedUrl);
  }
  return urls;
}
