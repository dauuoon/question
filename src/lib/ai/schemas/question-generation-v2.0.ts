export const QUESTION_GENERATION_SCHEMA = {
  "name": "why_box_question_generation_v2_0",
  "strict": true,
  "schema": {
    "type": "object",
    "properties": {
      "questions": {
        "type": "array",
        "minItems": 5,
        "maxItems": 5,
        "items": {
          "type": "object",
          "properties": {
            "candidate_rank": {
              "type": "integer",
              "minimum": 1,
              "maximum": 5
            },
            "question_text": {
              "type": "string"
            },
            "content_principle": {
              "type": "string",
              "enum": [
                "사고의 자각과 외재화",
                "사고의 근거와 구조 검토",
                "사고의 확장과 재구성",
                "탐색적 실행과 검증",
                "자기점검과 조절"
              ]
            },
            "question_type": {
              "type": "string",
              "enum": [
                "자기인식 질문",
                "사고 외재화 질문",
                "언어화 질문",
                "시각화 질문",
                "의도 및 판단 근거 질문",
                "가정 탐색 질문",
                "개념 명료화 질문",
                "관계 탐색 질문",
                "결과 예상 질문",
                "사고 점검 질문",
                "문제 재구성 질문",
                "사용자 및 맥락 확장 질문",
                "경험 및 사례 연결 질문",
                "제약 재검토 질문",
                "해결방식 재검토 질문",
                "상충 관점 질문",
                "시스템 관점 질문",
                "우선순위 질문",
                "대안 생성 질문",
                "시각화 및 구체화 질문",
                "실험 및 프로토타이핑 질문",
                "가치 및 적합성 검토 질문",
                "수행 모니터링 질문",
                "자기변화 관찰 질문",
                "예상 및 결과 비교 질문",
                "행동 및 반응 관찰 질문",
                "목표 및 전략 조절 질문"
              ]
            },
            "related_contexts": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "answer_guides": {
              "type": "array",
              "minItems": 0,
              "maxItems": 3,
              "items": {
                "type": "string"
              }
            },
            "target": {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "enum": [
                    "region",
                    "image",
                    "multi_image"
                  ]
                },
                "image_indices": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 10,
                  "items": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 10
                  }
                },
                "region": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "x": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 1
                        },
                        "y": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 1
                        },
                        "width": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 1
                        },
                        "height": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 1
                        }
                      },
                      "required": [
                        "x",
                        "y",
                        "width",
                        "height"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "type",
                "image_indices",
                "region"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "candidate_rank",
            "question_text",
            "content_principle",
            "question_type",
            "related_contexts",
            "answer_guides",
            "target"
          ],
          "additionalProperties": false
        }
      }
    },
    "required": [
      "questions"
    ],
    "additionalProperties": false
  }
} as const;
