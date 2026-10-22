import { z } from "zod";
import { answerRevisionSchema } from "../answers/revision";

export const QUESTION_FOLLOWUP_SCHEMA_VERSION = "why_box_question_followup_v1_0";
export const QUESTION_FOLLOWUP_SCHEMA = {
  name: QUESTION_FOLLOWUP_SCHEMA_VERSION,
  strict: true,
  schema: {
    type: "object",
    properties: {
      outcome: { type: "string", enum: ["generated", "no_followup"] },
      followup_question: { type: ["string", "null"] },
    },
    required: ["outcome", "followup_question"],
    additionalProperties: false,
  },
} as const;

export const questionFollowupOutputSchema = z.object({
  outcome: z.enum(["generated", "no_followup"]),
  followup_question: z.string().trim().min(1).max(2000).nullable(),
}).strict().superRefine((value, context) => {
  if ((value.outcome === "generated") !== (value.followup_question !== null)) {
    context.addIssue({ code: "custom", message: "Outcome and follow-up question do not match" });
  }
});

export const questionFollowupRequestSchema = z.object({
  question_id: z.uuid(),
  request_id: z.uuid(),
  expected_updated_at: answerRevisionSchema,
}).strict();

export const questionFollowupErrorMessages: Record<string, string> = {
  "FOLLOWUP-INPUT": "요청을 확인해주세요.",
  "FOLLOWUP-AUTH": "후속 질문을 생성할 권한이 없습니다.",
  "FOLLOWUP-STATE": "현재 상태에서는 후속 질문을 생성할 수 없습니다.",
  "FOLLOWUP-STALE": "답변이 변경되었습니다. 저장 상태를 확인한 뒤 다시 시도해주세요.",
  "FOLLOWUP-EMPTY": "먼저 답변을 작성하고 저장해주세요.",
  "FOLLOWUP-ALREADY": "이 질문에는 이미 후속 질문이 생성되었습니다.",
  "FOLLOWUP-DUPLICATE": "같은 답변으로는 후속 질문을 다시 요청할 수 없습니다. 답변을 수정한 뒤 시도해주세요.",
  "FOLLOWUP-PENDING": "후속 질문 요청 결과를 확인하고 있습니다. 잠시 후 다시 확인해주세요.",
  "FOLLOWUP-CONFIG": "후속 질문 생성 설정을 확인할 수 없습니다.",
  "FOLLOWUP-RATE": "AI 요청이 일시적으로 제한되었습니다. 잠시 후 다시 시도해주세요.",
  "FOLLOWUP-OUTPUT": "후속 질문 결과를 확인할 수 없습니다. 답변은 저장되어 있습니다.",
  "FOLLOWUP-TIMEOUT": "후속 질문 결과를 확인하지 못했습니다. 중복 요청을 막기 위해 답변을 수정한 뒤 다시 시도해주세요.",
  "FOLLOWUP-UNKNOWN": "후속 질문 결과를 확인하지 못했습니다. 답변을 수정하기 전에는 같은 요청을 다시 보내지 않습니다.",
  "FOLLOWUP-DB": "후속 질문을 저장하지 못했습니다. 답변은 보존되어 있습니다.",
  "FOLLOWUP-API": "후속 질문을 생성하지 못했습니다. 잠시 후 다시 시도해주세요.",
};

export class QuestionFollowupError extends Error {
  constructor(readonly code: string, readonly status = 503) {
    super(code);
    this.name = "QuestionFollowupError";
  }
}
