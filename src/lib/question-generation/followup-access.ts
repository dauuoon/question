import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { QuestionFollowupError } from "../ai/question-followup-contract";

export async function readQuestionFollowupAccess(
  caller: SupabaseClient,
  userId: string,
  env: Record<string, string | undefined> = process.env,
) {
  if (env.OPENAI_QUESTION_FOLLOWUP_ENABLED !== "true") return { enabled: false };
  const result = await caller.from("profiles").select("role,status")
    .eq("id", userId).maybeSingle();
  if (result.error) throw new QuestionFollowupError("FOLLOWUP-DB");
  const profile = result.data;
  return { enabled: profile?.role === "participant" && profile.status === "active" };
}
