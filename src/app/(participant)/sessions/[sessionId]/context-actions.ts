"use server";

import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/errors/report";
import { recordParticipantActivity } from "@/lib/activity/record";
import { sessionContextSchema, type ContextSaveResult } from "@/lib/session-context/input";
import { selectableQuestionCountSchema } from "@/lib/question-generation/view-contract";

const contextSupplementSaveSchema = z.object({
  context_text: z.string().max(1000),
  expected_revision: z.number().int().min(0),
}).strict();
const contextSupplementResultSchema = z.object({
  revision: z.number().int().min(0),
  context_text: z.string().max(1000),
}).strict();

export type ContextSupplementSaveResult =
  | { success: true; revision: number; context_text: string; activityRecorded: boolean }
  | { success: false; message: string };

export async function saveQuestionCount(sessionId: string, value: number): Promise<ContextSaveResult> {
  if (!z.uuid().safeParse(sessionId).success || !selectableQuestionCountSchema.safeParse(value).success) {
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

export async function saveSessionContextSupplement(
  sessionId: string, value: unknown,
): Promise<ContextSupplementSaveResult> {
  const input = contextSupplementSaveSchema.safeParse(value);
  if (!z.uuid().safeParse(sessionId).success || !input.success) {
    const error = await reportError("SAVE-001", "context-supplement.input");
    return { success: false, message: error.message };
  }
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      const error = await reportError("AUTH-002", "context-supplement.auth", {}, authError?.code);
      return { success: false, message: error.message };
    }
    const profile = await supabase.from("profiles").select("role,status").eq("id", user.id).maybeSingle();
    if (profile.error || profile.data?.role !== "participant" || profile.data.status !== "active") {
      const error = await reportError("AUTH-002", "context-supplement.role", {}, profile.error?.code);
      return { success: false, message: error.message };
    }
    const saved = await supabase.rpc("save_session_context_supplement", {
      p_session_id: sessionId,
      p_context_text: input.data.context_text,
      p_expected_revision: input.data.expected_revision,
    });
    if (saved.error) {
      const message = saved.error.code === "40001"
        ? "작업 맥락이 다른 곳에서 변경되었습니다. 새로고침한 뒤 다시 저장해주세요."
        : (await reportError("SAVE-001", "context-supplement.save", { sessionId }, saved.error.code)).message;
      return { success: false, message };
    }
    const result = contextSupplementResultSchema.safeParse(saved.data);
    if (!result.success || result.data.context_text !== input.data.context_text) {
      const error = await reportError("SAVE-001", "context-supplement.result", { sessionId });
      return { success: false, message: error.message };
    }
    const activityRecorded = await recordParticipantActivity("context_saved");
    return { success: true, ...result.data, activityRecorded };
  } catch {
    const error = await reportError("SAVE-001", "context-supplement.unexpected", { sessionId });
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
