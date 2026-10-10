import { z } from "zod";
import { DESIGN_CATEGORIES, REFLECTION_CONTEXTS, WORK_STAGES } from "../constants/research-options";

export const MAX_CONTEXT_LENGTH = 1000;
export const characterCount = (text: string) => Array.from(text).length;

export const sessionContextSchema = z.object({
  primary_category_id: z.string().nullable(),
  subcategory_id: z.string().nullable(),
  other_category_text: z.string().nullable(),
  stage_id: z.string().nullable(),
  additional_context: z.string().nullable(),
  context_ids: z.array(z.string()).max(3),
}).strict().superRefine((value, ctx) => {
  const category = DESIGN_CATEGORIES.find((item) => item.id === value.primary_category_id);
  if (value.primary_category_id !== null && !category) {
    ctx.addIssue({ code: "custom", message: "디자인 분야를 확인해주세요." });
  }
  if (value.subcategory_id !== null && !category?.items.some((item) => item.id === value.subcategory_id)) {
    ctx.addIssue({ code: "custom", message: "세부 분야를 확인해주세요." });
  }
  if (value.other_category_text !== null && value.primary_category_id !== "others") {
    ctx.addIssue({ code: "custom", message: "기타 설명은 기타 분야에서만 입력할 수 있습니다." });
  }
  if (value.stage_id !== null && !WORK_STAGES.some((item) => item.id === value.stage_id)) {
    ctx.addIssue({ code: "custom", message: "작업 단계를 확인해주세요." });
  }
  if (new Set(value.context_ids).size !== value.context_ids.length ||
    value.context_ids.some((id) => !REFLECTION_CONTEXTS.some((item) => item.id === id))) {
    ctx.addIssue({ code: "custom", message: "점검 영역을 확인해주세요." });
  }
  if (characterCount(value.additional_context ?? "") > MAX_CONTEXT_LENGTH) {
    ctx.addIssue({ code: "custom", message: "작업 맥락은 최대 1,000자입니다." });
  }
});

export type SessionContextInput = z.infer<typeof sessionContextSchema>;

export function contextKey(value: SessionContextInput): string {
  return JSON.stringify({
    ...value,
    other_category_text: value.other_category_text || null,
    additional_context: value.additional_context || null,
    context_ids: [...value.context_ids].sort(),
  });
}

export type ContextSaveResult =
  | { success: true; changed: boolean; activityRecorded: boolean }
  | { success: false; message: string };
