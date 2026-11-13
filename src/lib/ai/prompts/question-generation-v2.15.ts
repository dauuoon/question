import { QUESTION_GENERATION_PROMPT as previous } from "./question-generation-v2.14";
import { QUESTION_FUNCTION_UNDERSTANDING } from "./question-function-understanding";

export const QUESTION_GENERATION_PROMPT_VERSION = "question-generation-v2.15";
export const QUESTION_GENERATION_PROMPT = `${previous
  .replace("QUESTION GENERATION PROMPT v2.14","QUESTION GENERATION PROMPT v2.15")
  .replace("문구 자체의 의미를 검토할 때 실제 화면에 확인된 원문이 '현재 복용중인약 관리하기'라면:\n\"사용자는 '현재 복용중인약 관리하기'를 보고 무엇을 관리할 수 있다고 생각할까요?\"\n질문에 영향을 주지 않는 '영양제를 관리하려는 사람'이라는 설명은 생략한다. 원문의 띄어쓰기도 고치지 않는다.",
    "화면에 확인된 문구가 '현재 복용 중인 약 관리하기'이고 기능 이해를 묻는다면:\n\"사용자는 ‘현재 복용 중인 약 관리하기’를 보고 어떤 기능이라고 생각할까요?\"\n질문의 의미를 바꾸지 않는 사용자 설명은 생략하며 실제 화면의 원문을 유지한다.")}\n\n${QUESTION_FUNCTION_UNDERSTANDING}`;
