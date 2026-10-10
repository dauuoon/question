import "server-only";
import type { ErrorType } from "@/lib/errors/catalog";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type ErrorLogInput = {
  errorCode: string;
  errorType: ErrorType;
  participantId?: string | null;
  sessionId?: string | null;
  relatedQuestionId?: string | null;
  internalErrorMessage: string;
  retryable: boolean;
};

export async function writeErrorLog(input: ErrorLogInput) {
  const supabase = createSupabaseAdminClient();

  const { error } = await supabase.from("error_logs").insert({
    error_code: input.errorCode,
    error_type: input.errorType,
    participant_id: input.participantId ?? null,
    session_id: input.sessionId ?? null,
    related_question_id: input.relatedQuestionId ?? null,
    internal_error_message: input.internalErrorMessage,
    retryable: input.retryable,
  });

  if (error) {
    throw new Error(`Failed to persist the internal error log: ${error.message}`);
  }
}
