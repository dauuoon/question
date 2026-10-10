"use server";

import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/errors/report";
import { recordParticipantActivity } from "@/lib/activity/record";
import { sessionContextSchema, type ContextSaveResult } from "@/lib/session-context/input";
import { questionCountSchema } from "@/lib/question-generation/view-contract";

export async function saveQuestionCount(sessionId: string, value: number): Promise<ContextSaveResult> {
  if (!z.uuid().safeParse(sessionId).success || !questionCountSchema.safeParse(value).success) {
    const error = await reportError("SAVE-001", "question-count.input");
    return { success: false, message: error.message };
  }
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      const error = await reportError("AUTH-002", "question-count.auth", {}, authError?.code);
      return { success: false, message: error.message };
    }
    const profile = await supabase.from("profiles").select("role,status").eq("id", user.id).maybeSingle();
    if (profile.error || profile.data?.role !== "participant" || profile.data.status !== "active") {
      const error = await reportError("AUTH-002", "question-count.role", {}, profile.error?.code);
      return { success: false, message: error.message };
    }
    const saved = await supabase.from("sessions").update({ requested_question_count: value })
      .eq("id", sessionId).eq("participant_id", user.id).in("status", ["draft", "question_generation"])
      .select("requested_question_count").maybeSingle();
    if (saved.error || saved.data?.requested_question_count !== value) {
      const error = await reportError("SAVE-001", "question-count.save", { sessionId }, saved.error?.code);
      return { success: false, message: error.message };
    }
    return { success: true, changed: true, activityRecorded: await recordParticipantActivity("context_saved") };
  } catch {
    const error = await reportError("SAVE-001", "question-count.unexpected", { sessionId });
    return { success: false, message: error.message };
  }
}

export async function saveSessionContext(sessionId: string, value: unknown): Promise<ContextSaveResult> {
  const input = sessionContextSchema.safeParse(value);
  if (!z.uuid().safeParse(sessionId).success || !input.success) {
    const error = await reportError("SAVE-001", "context.input");
    return { success: false, message: error.message };
  }
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      const error = await reportError("AUTH-002", "context.auth", {}, authError?.code);
      return { success: false, message: error.message };
    }
    const profile = await supabase.from("profiles").select("role, status").eq("id", user.id).maybeSingle();
    if (profile.error || profile.data?.role !== "participant" || profile.data.status !== "active") {
      const error = await reportError("AUTH-002", "context.role", {}, profile.error?.code);
      return { success: false, message: error.message };
    }
    const { data, error: saveError } = await supabase.rpc("save_session_context", {
      p_session_id: sessionId,
      p_primary_category_id: input.data.primary_category_id,
      p_subcategory_id: input.data.subcategory_id,
      p_other_category_text: input.data.other_category_text || null,
      p_stage_id: input.data.stage_id,
      p_additional_context: input.data.additional_context || null,
      p_context_ids: input.data.context_ids,
    });
    if (saveError || typeof data !== "boolean") {
      const error = await reportError("SAVE-001", "context.save", { sessionId }, saveError?.code);
      return { success: false, message: error.message };
    }
    const activityRecorded = !data || await recordParticipantActivity("context_saved");
    return { success: true, changed: data, activityRecorded };
  } catch {
    const error = await reportError("SAVE-001", "context.unexpected", { sessionId });
    return { success: false, message: error.message };
  }
}
