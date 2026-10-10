import type { SupabaseClient } from "@supabase/supabase-js";
import { directUploadReservationSchema, imageUploadPath } from "./direct-upload-contract";
import { IMAGE_BUCKET, validateImageFile } from "./limits";
import { errorCatalog } from "../errors/catalog";
import type { PendingImageUpload } from "./upload-request";

export async function uploadImageDirect(
  client: SupabaseClient, sessionId: string, upload: PendingImageUpload,
): Promise<Response> {
  const invalid = validateImageFile(upload.file);
  if (invalid) {
    const definition = errorCatalog[invalid];
    return Response.json({ errorCode: invalid, message: `${definition.participantMessage} (${invalid})`, retryable: false },
      { status: 400 });
  }
  const bytes = await upload.file.arrayBuffer();
  const header = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 8));
  const signatureMatches = upload.file.type === "image/png"
    ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte)
    : header[0] === 255 && header[1] === 216 && header[2] === 255;
  let decodable = false;
  if (signatureMatches) {
    try {
      const bitmap = await createImageBitmap(upload.file);
      decodable = bitmap.width > 0 && bitmap.height > 0;
      bitmap.close();
    } catch {
      decodable = false;
    }
  }
  if (!decodable) {
    const definition = errorCatalog["UPLOAD-002"];
    return Response.json({ errorCode: "UPLOAD-002", message: `${definition.participantMessage} (UPLOAD-002)`, retryable: false },
      { status: 400 });
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const contentSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const mimeType = upload.file.type === "image/jpeg" ? "image/jpeg" as const : "image/png" as const;
  const input = {
    session_id: sessionId, request_id: upload.requestId, original_filename: upload.file.name,
    mime_type: mimeType, file_size: upload.file.size, content_sha256: contentSha256,
  };
  const post = (action: "reserve" | "finalize") => fetch("/api/session-images", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, action }), cache: "no-store",
  });
  const reserved = await post("reserve");
  if (!reserved.ok) return reserved;
  const reservation = directUploadReservationSchema.safeParse(await reserved.json());
  const auth = await client.auth.getUser();
  if (!reservation.success || auth.error || !auth.data.user ||
    reservation.data.storage_path !== imageUploadPath(auth.data.user.id, input)) {
    throw new Error("Invalid authenticated upload reservation.");
  }
  const stored = await client.storage.from(IMAGE_BUCKET).upload(reservation.data.storage_path, upload.file, {
    contentType: upload.file.type, upsert: false,
  });
  const error = stored.error;
  const duplicate = error && (error.status === 409 || error.statusCode === "409" ||
    ("code" in error && ["ResourceAlreadyExists", "Duplicate"].includes(String(error.code))));
  if (error && !duplicate) {
    const definition = errorCatalog["UPLOAD-001"];
    return Response.json({
      errorCode: "UPLOAD-001", message: `${definition.participantMessage} (UPLOAD-001)`, retryable: true,
    }, { status: 503 });
  }
  // Duplicate/ambiguous prior uploads still require server-side byte verification.
  return post("finalize");
}
