import { DESIGN_CATEGORIES, REFLECTION_CONTEXTS, WORK_STAGES } from "../constants/research-options";
import type { SessionContextInput } from "./input";

export const SESSION_STEPS = ["이미지 입력", "정보 입력", "작업 맥락"] as const;
export type SessionStep = 1 | 2 | 3;

export const sessionStepStorageKey = (sessionId: string) => `why-box:session-step:${sessionId}`;

export function parseSavedSessionStep(value: string | null): SessionStep {
  if (value === null) return 1;
  if (value === "1" || value === "2" || value === "3") return Number(value) as SessionStep;
  throw new Error("Invalid saved session step.");
}

export function validateSessionStep(
  step: SessionStep,
  value: SessionContextInput,
  imageCount: number | null,
): string | null {
  if (step === 1) {
    if (imageCount === null) return "이미지 목록을 확인한 후 다시 시도해주세요.";
    if (imageCount < 1) return "디자인 이미지를 1개 이상 업로드해주세요.";
  }
  if (step === 2) {
    const category = DESIGN_CATEGORIES.find((item) => item.id === value.primary_category_id);
    if (!category) return "디자인 1차 분야를 선택해주세요.";
    if (!category.items.some((item) => item.id === value.subcategory_id)) {
      return "디자인 2차 분야를 선택해주세요.";
    }
    if (category.id === "others" && !value.other_category_text?.trim()) {
      return "기타 디자인 분야를 직접 입력해주세요.";
    }
    if (!WORK_STAGES.some((item) => item.id === value.stage_id)) return "현재 작업 단계를 선택해주세요.";
    if (value.context_ids.length === 0) return "점검하고 싶은 부분을 1개 이상 선택해주세요.";
    if (value.context_ids.length > 3 || new Set(value.context_ids).size !== value.context_ids.length ||
      value.context_ids.some((id) => !REFLECTION_CONTEXTS.some((item) => item.id === id))) {
      return "점검하고 싶은 부분은 서로 다른 항목으로 최대 3개까지 선택해주세요.";
    }
  }
  return null;
}
