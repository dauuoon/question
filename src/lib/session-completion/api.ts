export class SessionCompletionApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "SessionCompletionApiError";
  }
}

export function hasSameOrigin(request: Request & { nextUrl?: URL }): boolean {
  const protocol = request.headers.get("x-forwarded-proto") ?? request.nextUrl?.protocol.slice(0, -1);
  const host = request.headers.get("host");
  return Boolean(host && protocol && request.headers.get("origin") === `${protocol}://${host}`);
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new SessionCompletionApiError("COMPLETION-INPUT", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new SessionCompletionApiError("COMPLETION-LENGTH", 413);
    }
    chunks.push(chunk.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new SessionCompletionApiError("COMPLETION-INPUT", 400);
  }
}
