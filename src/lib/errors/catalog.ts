export const errorTypes = [
  "AUTH",
  "UPLOAD",
  "AI",
  "SAVE",
  "NETWORK",
  "UNKNOWN",
] as const;

export type ErrorType = (typeof errorTypes)[number];

export type ErrorDefinition = {
  type: ErrorType;
  participantMessage: string;
  retryable: boolean;
};

export const errorCatalog = {
  "AUTH-001": {
    type: "AUTH",
    participantMessage:
      "로그인 정보를 확인할 수 없습니다. 참여자 코드와 비밀번호를 확인한 뒤 다시 시도해주세요.",
    retryable: true,
  },
  "AUTH-002": {
    type: "AUTH",
    participantMessage:
      "계정에 접근할 수 없습니다. 연구자에게 오류 코드를 알려주세요.",
    retryable: false,
  },
  "AUTH-003": {
    type: "AUTH",
    participantMessage: "참여자 코드 또는 비밀번호 조건을 확인해주세요. 코드가 이미 사용 중일 수도 있습니다.",
    retryable: false,
  },
  "AUTH-004": {
    type: "AUTH",
    participantMessage: "계정 처리를 완료하지 못했습니다. 연구자에게 오류 코드를 알려주세요.",
    retryable: true,
  },
  "AUTH-005": {
    type: "AUTH",
    participantMessage: "로그인 세션이 만료되었거나 유효하지 않습니다. 다시 로그인해주세요.",
    retryable: true,
  },
  "UPLOAD-001": {
    type: "UPLOAD",
    participantMessage:
      "이미지를 업로드하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해주세요.",
    retryable: true,
  },
  "UPLOAD-002": {
    type: "UPLOAD",
    participantMessage: "JPG/JPEG 또는 PNG 이미지만 등록할 수 있습니다.",
    retryable: false,
  },
  "UPLOAD-003": {
    type: "UPLOAD",
    participantMessage: "이미지당 최대 10MB까지 등록할 수 있습니다.",
    retryable: false,
  },
  "UPLOAD-004": {
    type: "UPLOAD",
    participantMessage: "세션에는 이미지를 최대 10개까지 등록할 수 있습니다.",
    retryable: false,
  },
  "UPLOAD-005": {
    type: "UPLOAD",
    participantMessage: "현재 세션에는 이미지를 추가할 수 없습니다. 세션 접근 권한과 진행 상태를 확인해주세요.",
    retryable: false,
  },
  "UPLOAD-006": {
    type: "UPLOAD",
    participantMessage: "이미지 정보를 저장하지 못했습니다. 저장된 이미지와 업로드 예약은 유지됩니다. 실패한 이미지 다시 시도를 눌러주세요.",
    retryable: true,
  },
  "UPLOAD-007": {
    type: "UPLOAD",
    participantMessage: "업로드 재시도 정보를 확인할 수 없습니다. 기존 이미지는 유지됩니다. 연구자에게 오류 코드를 알려주세요.",
    retryable: false,
  },
  "UPLOAD-008": {
    type: "UPLOAD",
    participantMessage: "이미지 삭제를 완료하지 못했습니다. 삭제 다시 시도를 눌러주세요. 완료 전까지 슬롯은 반환되지 않습니다.",
    retryable: true,
  },
  "UPLOAD-009": {
    type: "UPLOAD",
    participantMessage: "현재 이미지를 삭제할 수 없습니다. 세션 진행 상태와 삭제 기능 활성화 여부를 확인해주세요.",
    retryable: false,
  },
  "AI-001": {
    type: "AI",
    participantMessage:
      "AI 질문 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요. 문제가 계속되면 연구자에게 오류 코드를 알려주세요.",
    retryable: true,
  },
  "SAVE-001": {
    type: "SAVE",
    participantMessage:
      "변경 내용을 저장하지 못했습니다. 입력 내용은 유지되며 다시 시도할 수 있습니다.",
    retryable: true,
  },
  "SAVE-002": {
    type: "SAVE",
    participantMessage: "최근 사용일을 기록하지 못했습니다. 저장된 연구 데이터는 유지됩니다. 문제가 계속되면 연구자에게 오류 코드를 알려주세요.",
    retryable: true,
  },
  "NETWORK-001": {
    type: "NETWORK",
    participantMessage:
      "네트워크 연결에 문제가 있습니다. 연결을 확인한 뒤 다시 시도해주세요.",
    retryable: true,
  },
  "UNKNOWN-001": {
    type: "UNKNOWN",
    participantMessage:
      "문제가 발생했습니다. 잠시 후 다시 시도하고, 계속되면 연구자에게 오류 코드를 알려주세요.",
    retryable: false,
  },
} satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof errorCatalog;

export function getErrorDefinition(errorCode: string): ErrorDefinition {
  if (Object.hasOwn(errorCatalog, errorCode)) {
    return errorCatalog[errorCode as ErrorCode];
  }

  return errorCatalog["UNKNOWN-001"];
}
