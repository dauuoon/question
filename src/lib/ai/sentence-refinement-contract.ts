import { z } from "zod";
import { answerRevisionSchema } from "../answers/revision";

export const SENTENCE_REFINEMENT_MAX_CHARACTERS = 20_000;
export const SENTENCE_REFINEMENT_REQUEST_MS = 65_000;

export const sentenceRefinementRequestSchema = z.object({
  question_id:z.uuid(),
  expected_updated_at:answerRevisionSchema.nullable(),
}).strict();

export const sentenceRefinementResultSchema = z.object({
  refined_text:z.string().trim().min(1).max(SENTENCE_REFINEMENT_MAX_CHARACTERS),
  updated_at:answerRevisionSchema,
}).strict();

export class SentenceRefinementError extends Error {
  constructor(readonly code:string,readonly status=503) {
    super(code);
    this.name="SentenceRefinementError";
  }
}

export const sentenceRefinementErrorMessages:Record<string,string>={
  "REFINE-INPUT":"요청을 확인해주세요.",
  "REFINE-AUTH":"문장을 다듬을 권한이 없습니다.",
  "REFINE-STATE":"현재 상태에서는 문장을 다듬을 수 없습니다.",
  "REFINE-STALE":"답변이 변경되었습니다. 저장 상태를 확인한 뒤 다시 시도해주세요.",
  "REFINE-EMPTY":"먼저 나의 생각을 작성해주세요.",
  "REFINE-CONFIG":"문장 다듬기 설정을 확인할 수 없습니다.",
  "REFINE-RATE":"AI 서비스의 일시적인 요청 제한으로 문장을 다듬지 못했어요. 잠시 후 다시 시도해주세요.",
  "REFINE-QUOTA":"AI 서비스 사용 한도로 문장을 다듬을 수 없습니다. 관리자에게 문의해주세요. 작성한 답변은 유지됩니다.",
  "REFINE-CAPACITY":"문장 다듬기 요청이 많아 처리하지 못했어요. 잠시 후 다시 시도해주세요.",
  "REFINE-BUDGET":"TEST 문장 다듬기 호출 예산 3회를 모두 사용했습니다. 추가 호출은 차단됩니다.",
  "REFINE-BUSY":"이 답변의 문장을 정리하고 있어요. 잠시 후 저장 상태를 확인해주세요.",
  "REFINE-REFUSAL":"문장을 다듬지 못했어요. 다시 시도해주세요.",
  "REFINE-INCOMPLETE":"문장을 다듬지 못했어요. 다시 시도해주세요.",
  "REFINE-OUTPUT":"문장을 다듬지 못했어요. 다시 시도해주세요.",
  "REFINE-TIMEOUT":"문장을 다듬지 못했어요. 다시 시도해주세요.",
  "REFINE-DB":"저장 상태를 확인하지 못했습니다. 다시 시도해주세요.",
  "REFINE-API":"문장을 다듬지 못했어요. 다시 시도해주세요.",
};
