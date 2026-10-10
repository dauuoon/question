import { z } from "zod";
import { answerRevisionSchema } from "../answers/revision";

export const questionActionRequestSchema=z.object({
  session_id:z.uuid(),question_id:z.uuid(),request_id:z.uuid(),
  action:z.enum(["skip","regenerate"]),expected_answer_revision:answerRevisionSchema.nullable(),
}).strict();
export const questionActionCapabilitiesSchema=z.object({
  ready:z.boolean(),reserve_count:z.number().int().min(0).max(5),
  reserve_count_by_question:z.record(z.uuid(),z.number().int().min(0).max(5)),
  regeneration:z.object({
    ready:z.boolean(),calls_remaining:z.number().int().min(0).max(3),
    pending_request_id:z.uuid().nullable(),pending_question_id:z.uuid().nullable(),
    per_question:z.array(z.object({question_id:z.uuid(),reserve_count:z.number().int().min(0).max(5)}).strict()).max(5),
  }).strict().optional(),
}).strict();
export const questionActionCommitSchema=z.object({
  request_id:z.uuid(),question_id:z.uuid(),result_question_id:z.uuid(),changed:z.boolean(),
}).strict();
export class QuestionActionError extends Error {
  constructor(readonly code:string,readonly status=503) {super(code);this.name="QuestionActionError";}
}
export const questionActionMessages:Record<string,string>={
  "QA-INPUT":"질문 요청을 확인해주세요.",
  "QA-AUTH":"질문을 변경할 권한이 없습니다.",
  "QA-STATE":"답변이 작성되었거나 읽기 전용인 질문은 변경할 수 없습니다.",
  "QA-STALE":"질문 또는 답변 상태가 변경되었습니다. 저장 상태를 확인해주세요.",
  "QA-RESERVE":"사용하지 않은 준비 질문이 없어 재생성할 수 없습니다.",
  "QA-LIMIT":"이 질문은 이미 두 번 재생성했습니다.",
  "QA-UNAVAILABLE":"질문 변경 기능은 DB 적용 승인 후 사용할 수 있습니다.",
  "QA-DB":"질문 변경 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해주세요.",
};
