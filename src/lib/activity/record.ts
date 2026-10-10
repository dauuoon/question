import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/errors/report";

export type ResearchActivity = "screen_access" | "session_created" | "image_uploaded" | "image_deleted" | "context_saved" | "answer_saved" | "diary_saved" | "question_skipped" | "question_regenerated";

// Call only AFTER the research operation succeeds. Future answer/diary handlers reuse this entry point.
export async function recordParticipantActivity(activity: ResearchActivity): Promise<boolean> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      await reportError("AUTH-004", `activity.${activity}.auth`, {}, authError?.code);
      return false;
    }
    const { data: profile, error } = await supabase.from("profiles")
      .select("role, status").eq("id", user.id).maybeSingle();
    if (error) {
      await reportError("SAVE-002", `activity.${activity}.profile`, {}, error.code);
      return false;
    }
    if (profile?.role !== "participant" || profile.status !== "active") return false;
    const admin = createSupabaseAdminClient();
    const { error: recordError } = await admin.rpc("record_participant_activity", { p_participant_id: user.id });
    if (recordError) {
      await reportError("SAVE-002", `activity.${activity}.record`, { participantId: user.id }, recordError.code);
      return false;
    }
    return true;
  } catch {
    await reportError("SAVE-002", `activity.${activity}.unexpected`);
    return false;
  }
}
