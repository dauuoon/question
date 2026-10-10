export type PendingImageUpload = {
  file: File;
  requestId: string;
};

export function prepareImageUploads(files: File[]): PendingImageUpload[] {
  return files.map((file) => ({ file, requestId: crypto.randomUUID() }));
}

export function unsavedImageUploads(
  uploads: PendingImageUpload[],
  savedIds: readonly string[],
): PendingImageUpload[] {
  const saved = new Set(savedIds);
  return uploads.filter((upload) => !saved.has(upload.requestId));
}
