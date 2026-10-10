import "server-only";
import { errorCatalog, type ErrorCode } from "@/lib/errors/catalog";
import { writeErrorLog } from "@/lib/errors/log";

export async function reportError(
  code: ErrorCode,
  operation: string,
  context: { participantId?: string; sessionId?: string } = {},
  internalCode?: string,
) {
  const definition = errorCatalog[code];
  try {
    await writeErrorLog({
      errorCode: code,
      errorType: definition.type,
      retryable: definition.retryable,
      ...context,
      internalErrorMessage: `${operation}; code=${internalCode ?? "unspecified"}`,
    });
  } catch {
    console.error("WHY BOX: internal error log could not be saved.", { code, operation });
  }
  return {
    errorCode: code,
    message: `${definition.participantMessage} (${code})`,
    retryable: definition.retryable,
  };
}
