type SessionError = { name: string; status?: number; code?: string };

export function isInvalidAuthSession(error: SessionError): boolean {
  return error.name === "AuthSessionMissingError" || error.status === 401 ||
    (error.name === "AuthApiError" && [
      "refresh_token_not_found",
      "refresh_token_already_used",
      "session_not_found",
      "bad_jwt",
    ].includes(error.code ?? ""));
}
