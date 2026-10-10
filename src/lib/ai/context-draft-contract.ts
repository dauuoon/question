import { z } from "zod";
import { sessionContextSchema, type SessionContextInput } from "../session-context/input";
import { validateSessionStep } from "../session-context/wizard";

export const draftInputSchema = sessionContextSchema.refine(
  (value) => !validateSessionStep(2, value, null),
  "작업 정보와 점검 영역을 모두 선택해주세요.",
);
export const draftRequestSchema = z.object({
  session_id: z.uuid(),
  request_id: z.uuid(),
  mode: z.enum(["auto", "manual"]),
  input: draftInputSchema,
}).strict();
export type DraftRequest = z.infer<typeof draftRequestSchema>;

export function draftFingerprint(value: SessionContextInput, imageRevision: string): string {
  return JSON.stringify({
    primary: value.primary_category_id, secondary: value.subcategory_id,
    other: value.other_category_text, stage: value.stage_id,
    contexts: [...value.context_ids].sort(), images: imageRevision,
  });
}

export const draftErrorMessages = {
  "DRAFT-AUTH": "세션 접근 권한과 로그인 상태를 확인해주세요.",
  "DRAFT-INPUT": "이미지, 작업 정보와 점검 영역을 모두 확인해주세요.",
  "DRAFT-IMAGE": "이미지를 준비하지 못했습니다. 잠시 후 다시 시도해주세요.",
  "DRAFT-CONFIG": "AI 작업 맥락 생성 설정이 준비되지 않았습니다. 연구자에게 알려주세요.",
  "DRAFT-DB": "자동 생성 상태를 확인하지 못했습니다. 연구자에게 알려주세요.",
  "DRAFT-TIMEOUT": "AI 응답 시간이 초과되었습니다. 직접 다시 시도해주세요.",
  "DRAFT-RATE": "AI 요청이 제한되었습니다. 잠시 후 직접 다시 시도해주세요.",
  "DRAFT-API": "AI 작업 맥락 생성에 실패했습니다. 직접 다시 시도해주세요.",
  "DRAFT-EMPTY": "AI가 작업 맥락을 반환하지 않았습니다. 직접 다시 시도해주세요.",
  "DRAFT-REFUSAL": "AI가 이 입력의 작업 맥락 생성을 거절했습니다.",
  "DRAFT-INCOMPLETE": "AI 응답이 정상적으로 완료되지 않았습니다. 직접 다시 시도해주세요.",
  "DRAFT-LENGTH": "AI 작업 맥락이 1,000자를 초과했습니다. 직접 다시 시도해주세요.",
  "DRAFT-EDITED": "작성 중인 내용을 보호하기 위해 AI 응답을 반영하지 않았습니다.",
  "DRAFT-STALE": "이전 요청 또는 변경 전 작업 정보의 AI 응답을 반영하지 않았습니다.",
} as const;
export type DraftErrorCode = keyof typeof draftErrorMessages;
export class DraftError extends Error {
  constructor(public readonly code: DraftErrorCode, public readonly status = 502) {
    super(code);
  }
}
export const draftResponseSchema = z.union([
  z.object({ request_id: z.uuid(), draft_text: z.string().trim().min(1)
    .refine((text) => Array.from(text).length <= 1000) }).strict(),
  z.object({ request_id: z.uuid(), skipped: z.literal(true) }).strict(),
]);
