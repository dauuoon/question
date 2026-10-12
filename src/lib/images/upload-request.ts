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

export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer.");
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}
