import { z } from "zod";
import { MAX_IMAGE_BYTES } from "./limits";

const fields = z.object({
  session_id: z.uuid(),
  request_id: z.uuid(),
  original_filename: z.string().min(1).max(255),
  mime_type: z.enum(["image/jpeg", "image/png"]),
  file_size: z.number().int().min(1).max(MAX_IMAGE_BYTES),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
const filenameMatches = (input: z.infer<typeof fields>) => input.mime_type === "image/png"
  ? /\.png$/i.test(input.original_filename) : /\.jpe?g$/i.test(input.original_filename);

export const imageUploadInputSchema = fields.refine(filenameMatches);
export const imageUploadRequestSchema = fields.extend({
  action: z.enum(["reserve", "finalize"]),
}).refine(filenameMatches);

export const uploadReservationSchema = z.array(z.object({
  storage_path: z.string().min(1),
  slot_index: z.number().int().min(1).max(10),
  sort_order: z.number().int().nonnegative(),
})).length(1);

export const directUploadReservationSchema = z.object({
  storage_path: z.string().min(1),
}).strict();

export type ImageUploadInput = z.infer<typeof imageUploadInputSchema>;

export function imageUploadPath(participantId: string, input: ImageUploadInput) {
  return `${participantId}/${input.session_id}/${input.request_id}-${input.content_sha256}.${input.mime_type === "image/jpeg" ? "jpg" : "png"}`;
}
