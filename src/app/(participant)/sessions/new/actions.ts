"use server";

import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/role";
import { reportError } from "@/lib/errors/report";
import type { FormResult } from "@/lib/forms";
import { recordParticipantActivity } from "@/lib/activity/record";

export async function createDraftSession(): Promise<FormResult> {
  const { supabase, user } = await requireRole("participant");
  const sessionId = crypto.randomUUID();
  // The ownership SELECT policy reads persisted sessions, so don't request INSERT RETURNING.
  const { error } = await supabase.from("sessions")
    .insert({ id: sessionId, participant_id: user.id });
  if (error) {
    return reportError("SAVE-001", "session.create", { participantId: user.id }, error.code);
  }
  const activityRecorded = await recordParticipantActivity("session_created");
  redirect(`/sessions/${sessionId}${activityRecorded ? "" : "?activity_error=SAVE-002"}`);
}
