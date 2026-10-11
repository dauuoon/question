"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth/role";
import { participantCodeToAuthEmail } from "@/lib/auth/identity";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/errors/report";
import type { FormResult } from "@/lib/forms";
import { accountTypeSchema } from "@/lib/accounts/type";

const codeSchema = z.string().trim().toUpperCase().regex(/^[PT][0-9]{2,}$/);
const passwordSchema = z.string().min(6);

export async function createParticipant(
  _state: FormResult,
  formData: FormData,
): Promise<FormResult> {
  await requireRole("admin");
  const code = codeSchema.safeParse(formData.get("participant_code"));
  const password = passwordSchema.safeParse(formData.get("password"));
  const accountType = accountTypeSchema.safeParse(formData.get("account_type"));
  if (!code.success || !password.success || !accountType.success) {
    return reportError("AUTH-003", "participant.create.validation");
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email: participantCodeToAuthEmail(code.data),
    password: password.data,
    email_confirm: true,
  });
  if (error || !data.user) {
    return reportError("AUTH-003", "participant.create.auth", {}, error?.code);
  }

  const { error: profileError } = await admin.from("profiles").insert({
    id: data.user.id,
    participant_code: code.data,
    role: "participant",
    status: "active",
    account_type: accountType.data,
  });
  if (profileError) {
    const { error: cleanupError } = await admin.auth.admin.deleteUser(data.user.id);
    if (cleanupError) {
      return reportError("AUTH-004", "participant.create.compensation_failed", {}, cleanupError.code);
    }
    return reportError("AUTH-004", "participant.create.profile", {}, profileError.code);
  }

  revalidatePath("/admin/participants");
  revalidatePath("/admin");
  return {
    success: true,
    message: `${code.data} 계정을 생성했습니다. 설정한 임시 비밀번호를 참여자에게 직접 전달해주세요.`,
  };
}

export async function changeAccountType(
  _state: FormResult, formData: FormData,
): Promise<FormResult> {
  const { supabase } = await requireRole("admin");
  const input = z.object({
    id: z.uuid(), expected: accountTypeSchema.nullable(), type: accountTypeSchema,
    reason: z.string().trim().min(1).max(500), confirmed: z.literal("yes"),
  }).safeParse({
    id: formData.get("participant_id"),
    expected: formData.get("expected_type") === "" ? null : formData.get("expected_type"),
    type: formData.get("account_type"), reason: formData.get("reason"),
    confirmed: formData.get("confirmed"),
  });
  if (!input.success) return reportError("AUTH-003", "participant.type.validation");
  const { data, error } = await supabase.rpc("change_participant_account_type", {
    p_participant_id: input.data.id, p_expected_type: input.data.expected,
    p_account_type: input.data.type, p_reason: input.data.reason,
  });
  if (error || typeof data !== "boolean") {
    const failure = await reportError("AUTH-004", "participant.type.change", {}, error?.code);
    return { ...failure,
      message: "계정 유형을 변경하지 못했습니다. 최신 유형을 새로고침하여 확인한 뒤 다시 시도해주세요. (AUTH-004)" };
  }
  revalidatePath("/admin"); revalidatePath("/admin/participants");
  revalidatePath(`/admin/participants/${input.data.id}`);
  return { success: true, message: data ? "계정 유형과 변경 이력을 저장했습니다." : "이미 동일한 유형입니다." };
}

export async function manageParticipant(
  _state: FormResult,
  formData: FormData,
): Promise<FormResult> {
  const { supabase } = await requireRole("admin");
  const id = z.uuid().safeParse(formData.get("participant_id"));
  const operation = z.enum(["activate", "deactivate", "reset_password"]).safeParse(formData.get("operation"));
  if (!id.success || !operation.success) {
    return reportError("AUTH-003", "participant.manage.validation");
  }
  const { data: target, error } = await supabase.from("profiles")
    .select("role").eq("id", id.data).maybeSingle();
  if (error || target?.role !== "participant") {
    return reportError("AUTH-004", "participant.manage.target", {}, error?.code);
  }
  const admin = createSupabaseAdminClient();
  if (operation.data === "reset_password") {
    const password = passwordSchema.safeParse(formData.get("password"));
    if (!password.success) return reportError("AUTH-003", "participant.reset.validation");
    const { error: resetError } = await admin.auth.admin.updateUserById(id.data, {
      password: password.data,
    });
    if (resetError) return reportError("AUTH-004", "participant.reset", {}, resetError.code);
  } else {
    const { error: statusError } = await admin.from("profiles")
      .update({ status: operation.data === "activate" ? "active" : "deactivated" })
      .eq("id", id.data).eq("role", "participant");
    if (statusError) return reportError("AUTH-004", "participant.status", {}, statusError.code);
  }
  revalidatePath("/admin/participants");
  return { success: true, message: "계정 설정을 저장했습니다." };
}
