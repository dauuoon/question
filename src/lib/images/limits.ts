export const IMAGE_BUCKET = "why-box-images";
export const MAX_IMAGE_COUNT = 10;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png"] as const;

export type SessionImage = {
  id: string;
  original_filename: string;
  sort_order: number;
  previewUrl: string | null;
  deletionPending?: boolean;
};

export function validateImageFile(file: File): "UPLOAD-002" | "UPLOAD-003" | null {
  if (
    !IMAGE_MIME_TYPES.some((mime) => mime === file.type) ||
    !/\.(jpe?g|png)$/i.test(file.name)
  ) return "UPLOAD-002";
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) return "UPLOAD-003";
  return null;
}
