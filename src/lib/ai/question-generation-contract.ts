import { z } from "zod";

export const questionGenerationRequestSchema = z.object({
  session_id: z.uuid(),
  request_id: z.uuid(),
}).strict();
export type QuestionGenerationRequest = z.infer<typeof questionGenerationRequestSchema>;

export const questionGenerationErrorMessages = {
  "QGEN-AUTH": "세션 접근 권한과 로그인 상태를 확인해주세요.",
  "QGEN-INPUT": "저장된 작업 정보와 이미지를 확인해주세요.",
  "QGEN-BEGIN": "현재 세션에서 질문 생성을 시작할 수 없습니다.",
  "QGEN-DB": "질문 생성 상태를 확인하지 못했습니다. 같은 요청으로 다시 확인해주세요.",
  "QGEN-CONFIG": "질문 생성 설정이 준비되지 않았습니다. 연구자에게 알려주세요.",
  "QGEN-IMAGE": "질문 생성에 필요한 이미지를 준비하지 못했습니다.",
  "QGEN-API": "질문 생성 요청에 실패했습니다.",
  "QGEN-RATE": "AI 요청이 제한되었습니다. 잠시 후 다시 시도해주세요.",
  "QGEN-REFUSAL": "AI가 이 입력의 질문 생성을 거절했습니다.",
  "QGEN-INCOMPLETE": "AI 응답이 정상적으로 완료되지 않았습니다.",
  "QGEN-VALIDATION": "생성된 질문이 연구 기준을 충족하지 못했습니다.",
  "QGEN-CONTEXT": "생성된 질문의 점검 영역이 선택한 항목과 일치하지 않습니다.",
  "QGEN-STAGE": "질문 후보 저장을 확인하지 못했습니다. 같은 요청으로 다시 확인해주세요.",
  "QGEN-COMMIT": "질문 저장을 완료하지 못했습니다. 같은 요청으로 다시 확인해주세요.",
  "QGEN-TIMEOUT": "질문 생성 요청 시간이 초과되었습니다.",
  "QGEN-CANCELLED": "질문 생성 요청이 중단되었습니다.",
  "QGEN-FAILED": "이 요청은 실패한 요청입니다. 새 요청으로 다시 시작해주세요.",
  "QGEN-RECOVERY": "질문 생성 상태 복구를 확인하지 못했습니다. 연구자에게 알려주세요.",
} as const;
export type QuestionGenerationErrorCode = keyof typeof questionGenerationErrorMessages;
export class QuestionGenerationError extends Error {
  constructor(public readonly code: QuestionGenerationErrorCode, public readonly status = 502) {
    super(code);
  }
}

export type QuestionGenerationResult =
  | { request_id: string; attempt_id: string; status: "running"; retry_same_request: true }
  | { request_id: string; attempt_id: string; status: "completed"; question_ids: string[] };
