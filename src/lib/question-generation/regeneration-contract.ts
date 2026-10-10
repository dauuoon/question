import { z } from "zod";
import { questionActionCommitSchema } from "./actions-contract";

export const regenerationStateSchema=z.enum([
  "reserved","dispatch_started","staged","committed","failed","outcome_unknown","stale",
]);
export const regenerationStatusSchema=z.object({
  request_id:z.uuid(),question_id:z.uuid(),status:regenerationStateSchema,
  attempt_id:z.uuid().nullable(),result_question_id:z.uuid().nullable(),
  changed:z.boolean(),method:z.enum(["reserve","api_generated"]).nullable(),
  failure_code:z.string().nullable().optional(),
}).strict();
export const regenerationBeginSchema=regenerationStatusSchema.extend({acquired:z.boolean()});
export const regenerationPendingSchema=regenerationStatusSchema.extend({
  retry_after_ms:z.number().int().min(100).max(10000),
}).strict();
export type RegenerationStatus=z.infer<typeof regenerationStatusSchema>;
export type RegenerationBegin=z.infer<typeof regenerationBeginSchema>;
export type RegenerationCommit=z.infer<typeof questionActionCommitSchema>;
export const regenerationMessages:Record<string,string>={
  "QR-CONFIG":"새 질문 생성은 현재 사용할 수 없습니다.",
  "QR-BUSY":"다른 질문 변경 요청이 처리 중입니다. 결과를 먼저 확인해주세요.",
  "QR-CALL-LIMIT":"이 세션의 새 질문 생성 요청 횟수를 모두 사용했습니다.",
  "QR-IMAGE":"디자인 이미지를 확인하지 못했습니다. 기존 질문은 유지됩니다.",
  "QR-TIMEOUT":"새 질문 생성 결과를 확인하지 못했습니다. 기존 질문은 유지됩니다.",
  "QR-API":"새 질문을 생성하지 못했습니다. 기존 질문은 유지됩니다.",
  "QR-REFUSAL":"새 질문을 생성할 수 없었습니다. 기존 질문은 유지됩니다.",
  "QR-INCOMPLETE":"새 질문 생성이 완료되지 않았습니다. 기존 질문은 유지됩니다.",
  "QR-VALIDATION":"새 질문 형식을 확인하지 못했습니다. 기존 질문은 유지됩니다.",
  "QR-DUPLICATE":"기존 질문과 다른 관점의 질문을 확인하지 못했습니다. 기존 질문은 유지됩니다.",
  "QR-OUTCOME-UNKNOWN":"요청 결과를 확인할 수 없습니다. 자동으로 다시 생성하지 않습니다.",
  "QR-RECOVERY":"질문 변경 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해주세요.",
};
