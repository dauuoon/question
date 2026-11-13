import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function answerFormsReady(caller: SupabaseClient, signal: AbortSignal): Promise<boolean> {
  const result = await caller.rpc("choice_answer_history_access_ready", {}).abortSignal(signal);
  return !result.error && result.data === true;
}
