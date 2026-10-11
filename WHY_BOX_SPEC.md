# WHY BOX v1.0 — Development Specification

> 디자이너의 성찰적 사고 지원을 위한 웹 기반 AI 질문 생성 도구

---

# 0. 문서 목적

본 문서는 WHY BOX v1.0 연구용 MVP의 개발 기준을 정의한다.

WHY BOX는 석사학위 연구에서 실제 디자이너를 대상으로 사용될 연구 도구이므로, 일반적인 서비스 개발보다 **연구 데이터의 일관성과 기록 보존**을 중요하게 다룬다.

개발 과정에서는 본 문서에 정의된 핵심 연구 로직을 임의로 변경하지 않는다.

특히 다음 항목을 우선한다.

- 질문 생성 과정의 일관성
- 사용자 응답의 원본 보존
- 질문 재생성 및 후속 질문 이력 보존
- 세션 단위의 사용 기록
- 연구 분석에 필요한 AI 생성 메타데이터 저장
- 중단된 세션의 복구
- 참여자별 사용 횟수 및 다이어리 완료 여부 관리

UI의 세부적인 시각 표현은 개발 과정에서 조정할 수 있으나, 연구 데이터 구조와 핵심 사용 흐름은 유지한다.

## 0.1 운영 UI 및 관리자 연구 내보내기 보완

- 질문 생성 성공은 세션 완료와 구분한다. 생성 직후 새로고침 없이 질문 선택·답변 작성이 가능해야 한다.
- 디자인 브리핑 탭은 세션 완료와 저장된 브리핑 조회 성공 이후에만 노출한다. `summary_ready`는 완료가 아니며 기존 쓰기 동결·재시도 정책을 유지한다.
- 질문 핀 말풍선을 닫아도 질문 선택은 유지한다. 말풍선 위치는 이미지 기준으로 계산하고 크기 변경 시 갱신한다.
- 관리자 대시보드는 실제 DB의 P 연구 참여자·P 전체/완료 세션·P 제출 다이어리 수와 최신 활동 순 세션 목록을 제공한다.
- 관리자만 P 계정의 전체 세션·특정 세션·전체 다이어리·특정 참여자의 `.xlsx` 기록을 다운로드할 수 있다. 다운로드 API에서도 활성 관리자와 명시적 P 분류를 재검증한다. 다이어리 초안도 상태와 함께 보존하며 제출 시각을 임의 생성하지 않는다.
- 질문 원본·재생성 계보, 답변 원문·정제본·최종 선택, 브리핑 원본·모든 수정 버전을 분리 보존한다. 복수 선택은 JSON 배열, 시각은 Asia/Seoul (`+09:00`)로 출력한다.
- 내보내기는 연구 기록을 변경하지 않는다. 불필요한 개인정보·비밀정보는 제외하고 수식처럼 보이는 텍스트도 문자열 셀로 저장한다. 한도 초과 시 잘라내지 않고 참여자·세션별 분할 다운로드를 안내한다.

## 0.2 P/T 계정 분류 및 연구 통계 정책

- `role`은 관리자/일반 사용자 권한, `account_type`은 P(실제 연구 참여자)/T(검토·테스트) 데이터 분류다. 두 값은 별도로 관리한다.
- 계정 생성 시 P/T를 명시적으로 선택한다. 아이디 접두어는 분류 근거가 아니며 P/T 모두 동일한 WHY BOX 기능을 사용한다.
- 기존 계정은 `NULL`(미분류)로 보존한다. P01 운영 E2E 계정은 승인 후 T 전환 대상이며 이번 로컬 작업에서 직접 변경하지 않는다.
- 유형 변경에는 사유·확인 절차·변경 전 값 비교와 변경 이력을 둔다. 현재 유형이 해당 계정의 과거/향후 기록 전체에 적용된다. 변경해도 Auth UUID·로그인 코드·비밀번호·권한·기존 연구 기록을 바꾸지 않는다.
- 최소 5회 달성률은 완료 세션 5회 이상인 P 참여자 수 / 전체 P 참여자 수다. 활성/비활성 여부와 관계없이 P 계정 모두를 분모로 사용하고, 참여자가 0명이면 0%로 표시한다.
- 보조 서비스 사용량은 생성 세션 기준 P+T/P/T 수와 미분류 수(별도)다. 실제 OpenAI 호출 횟수나 비용으로 해석하지 않는다.
- 최근 세션 기본 필터는 P다. 관리자에게는 T/미분류 기록도 열람을 허용하되 연구 통계·모든 연구용 Excel에서는 T·미분류·관리자 기록을 제외한다.
- 특정 T 세션/참여자 ID를 직접 전달해도 연구용 파일을 제공하지 않는다. P 데이터가 없으면 빈 연구 파일을 제공하며 T 데이터로 대체하지 않는다.
- 분류 필드와 변경 이력/RPC에 필요한 Migration은 작성만 한다. 승인된 적용 이전에는 새 관리 UI를 배포하지 않으며, 분류 필드가 없다고 기존 ID를 P로 추정하지 않는다.

---

# 1. 서비스 목적

WHY BOX는 디자이너의 작업 결과물을 평가하거나 정답 및 해결책을 제공하는 AI 디자인 리뷰 도구가 아니다.

사용자가 자신의 디자인 작업을 다시 바라보면서 다음과 같은 내용을 스스로 탐색하도록 **질문을 생성하는 성찰 지원 도구**다.

- 내가 무엇을 의도하고 있는가?
- 왜 이러한 판단을 했는가?
- 어떤 기준이나 전제를 가지고 있는가?
- 다른 관점에서 바라볼 수 있는가?
- 현재 결과가 처음의 의도와 연결되는가?
- 다음에는 무엇을 확인하거나 시도할 수 있는가?

즉,

> AI가 답을 제공하는 것이 아니라  
> 디자이너가 자신의 사고를 다시 살펴볼 수 있도록 질문한다.

---

# 2. AI 기본 행동 원칙

WHY BOX의 AI는 다음 원칙을 반드시 따른다.

1. 디자인의 좋고 나쁨을 직접 평가하지 않는다.
2. 정답이나 완성된 해결책을 제공하지 않는다.
3. 직접적인 수정 지시를 하지 않는다.
4. 사용자의 선택을 부정하거나 단정하지 않는다.
5. 사용자가 자신의 판단을 설명하고 검토할 수 있도록 질문한다.
6. 개방형이고 비지시적인 질문을 우선한다.
7. 이미지에서 확인되는 내용을 질문의 구체적인 단서로 활용한다.
8. 사용자가 선택한 디자인 분야와 작업 단계를 고려한다.
9. 사용자가 선택한 점검 맥락을 질문 생성의 힌트로 활용한다.
10. 사용자의 답변을 정답/오답으로 평가하지 않는다.
11. 사용자의 답변은 후속 질문을 생성하기 위한 맥락으로 활용한다.
12. 최종 성찰 요약에는 사용자가 작성하지 않은 새로운 평가·조언·해결책을 추가하지 않는다.

---

# 3. 사용자 역할

서비스에는 두 종류의 사용자가 존재한다.

## 3.1 Participant

연구 참여자.

가능한 기능:

- 연구자가 제공한 계정으로 로그인
- 새로운 성찰 세션 시작
- 디자인 이미지 업로드
- 디자인 작업 정보 입력
- AI 질문 생성
- 질문에 답변
- 질문 건너뛰기
- 질문 다시 생성
- 표현 정리하기
- 후속 질문 생성
- 디자인 성찰 요약 확인
- 사용 다이어리 작성
- 자신의 과거 완료 기록 열람
- 중단된 세션 이어서 진행

제한:

- 직접 회원가입하지 않는다.
- 다른 참여자의 기록을 볼 수 없다.
- 완료된 세션의 기록은 수정할 수 없다.

---

## 3.2 Admin / Researcher

연구자용 관리자 계정.

가능한 기능:

- 참여자 계정 생성
- 참여자 정보 수정
- 참여자 계정 비활성화
- 임시 비밀번호 재설정
- 참여자별 사용 현황 확인
- 참여자별 다이어리 완료 현황 확인
- 전체 세션 기록 열람
- AI 질문 생성 로그 확인
- 질문/답변/재생성/후속 질문 이력 확인
- 사용 다이어리 확인
- 연구 데이터 CSV export

연구 데이터 보존을 위해 참여자 계정은 가능하면 실제 DB 삭제보다 `deactivated` 상태로 처리한다.

최초 운영 시 Admin 계정은 1개를 생성한다. 연구자는 이 Admin 계정으로 로그인하고, 이후 연구 참여자별 계정과 로그인 정보를 생성·관리한다. 참여자는 직접 회원가입하지 않으며, 연구자가 생성한 로그인 정보를 직접 전달받아 해당 계정으로 로그인한다.

일반 사용자 로그인 ID는 `P01`, `P02`, `T01` 등의 `participant_code`를 사용한다. 접두어는 로그인 식별자일 뿐이며 연구 분류는 명시적 `account_type`으로 판단한다. Participant 화면에서는 이메일 주소를 요구하거나 노출하지 않는다. Supabase Auth에서 이메일 식별자가 필요한 경우, 서버에서 participant code를 비라우팅 내부 Auth 이메일 식별자로 매핑하며 이 주소를 Participant 화면이나 연구자에게 전달하지 않는다. 임시 비밀번호를 전달하고 첫 로그인 강제 변경은 하지 않는다. Admin은 Participant 임시 비밀번호를 재설정할 수 있다.

최초 Admin 계정은 Supabase Dashboard에서 Auth 사용자로 직접 생성한 뒤, 해당 Auth 사용자 UUID로 `profiles` 행을 만들고 `role = admin`을 부여한다. 첫 Admin이 생성되기 전에는 애플리케이션의 공개 회원가입이나 자기 역할 승격 경로를 제공하지 않는다. 이후 Participant Auth 사용자 생성과 profile 등록은 Admin 인증을 확인하는 서버 측 관리자 기능에서 수행한다.

---

# 4. 기술 구성

기본 기술 스택은 다음과 같다.

- Frontend / Backend: Next.js
- Database: Supabase
- Authentication: Supabase Auth
- Image Storage: Supabase Storage
- Deployment: Vercel
- Source Control: GitHub
- AI: OpenAI API

## 보안 원칙

OpenAI API 호출은 서버에서 처리한다.

다음 값은 클라이언트에 노출하지 않는다.

- OpenAI API Key
- Supabase Service Role Key
- 기타 관리자용 Secret

---

# 5. AI 모델 버전 관리

개발 단계에서는 이미지 입력과 구조화된 출력이 가능한 OpenAI 모델을 사용한다.

실제 연구 시작 전 질문 품질과 비용을 테스트한 뒤 사용할 모델을 하나로 확정한다.

연구가 시작된 이후에는 가능하면 다음 값을 변경하지 않는다.

- AI model
- system prompt
- question framework
- structured output schema

각 AI 생성 기록에는 다음 값을 저장한다.

```text
model_id
prompt_version
framework_version
generated_at
```

예:

```text
model_id: [실험 전 확정]
prompt_version: v1.0
framework_version: v1.0
```

---

# 6. 전체 사용자 흐름

```text
로그인
↓
새 성찰 시작
↓
디자인 이미지 등록
↓
디자인 분야 선택
↓
현재 작업 단계 선택
↓
점검하고 싶은 부분 선택
↓
추가 설명 입력 (선택)
↓
질문 수 선택
↓
AI 질문 생성
↓
이미지 + 질문 Pin 표시
↓
질문 확인
↓
답변 또는 건너뛰기
↓
[선택] 표현 정리하기
↓
[선택] 후속 질문
↓
[선택] 질문 다시 생성
↓
모든 최초 질문 슬롯의 현재 active version 처리
↓
디자인 성찰 요약 보기
↓
디자인 성찰 요약본
↓
도구 사용 1회 완료
↓
사용 다이어리
```

---

# 7. Session 정의

한 번의 디자인 성찰 활동을 하나의 `session`으로 관리한다.

상태:

```text
draft
question_generation
in_progress
summary_ready
completed
```

상태 전이는 다음 순서를 따른다.

```text
draft
→ question_generation
→ in_progress
→ summary_ready
→ completed
```

`summary_ready`는 모든 최초 질문 슬롯의 현재 active version이 `answered` 또는 `skipped`이고, 그중 최소 1개 이상의 active version이 `answered`일 때 진입한다. 요약 생성에 실패하면 `summary_ready`를 유지하고 재시도할 수 있다. 요약 생성 및 저장이 성공한 경우에만 `completed`로 변경하고 `completed_at`을 기록한다.

---

## 7.1 세션 시작

사용자가 디자인 작업 정보와 이미지를 등록하고 질문 생성을 요청한다.

질문 생성이 성공하면 실제 성찰 활동이 시작된다.

모든 데이터는 하나의 `session_id`를 기준으로 연결한다.

---

## 7.2 최초 질문 슬롯 상태

각 최초 질문 슬롯의 현재 active version은 다음 상태 중 하나를 가진다.

```text
unprocessed
answered
skipped
```

후속 질문에 대한 응답 여부와 `표현 정리하기` 사용 여부는 세션 완료 조건에 포함하지 않는다.
비활성 질문 버전의 상태는 슬롯의 완료 판정에 사용하지 않는다.

---

# 8. 도구 사용 1회 완료 조건

다음 조건을 모두 만족해야 한다.

### 조건 1

모든 최초 질문 슬롯의 현재 active version이 다음 중 하나의 상태여야 한다.

```text
answered
skipped
```

### 조건 2

최소 1개의 최초 질문 슬롯에서 현재 active version에 실제 답변이 존재해야 한다.

즉, 모든 질문을 건너뛴 경우에는 세션을 완료할 수 없다.

안내 문구:

> 성찰 요약을 만들려면 최소 한 개의 질문에 답변해주세요.

### 조건 3

사용자가 `디자인 성찰 요약 보기`를 선택한다.

### 조건 4

성찰 요약 생성 및 저장이 성공한다. 생성 실패 시 세션은 `summary_ready`를 유지하고 재시도할 수 있다.

이 시점을 기준으로:

```text
session.status = completed
session.completed_at = timestamp
```

으로 기록한다. 요약 생성 및 저장에 성공한 뒤 요약 화면을 표시한다.

이때 **도구 사용 1회가 완료된 것으로 계산한다.**

---

# 9. 도구 사용과 다이어리 완료 분리

도구 사용 완료와 사용 다이어리 제출은 별도로 기록한다.

예:

```text
P03
도구 사용 5회
다이어리 작성 4회
```

따라서 다이어리를 작성하지 않았더라도 이미 성찰 요약까지 완료했다면 해당 세션 자체는 `completed` 상태를 유지한다.

5회는 시스템의 최대 사용 횟수가 아니라 연구 참여를 위한 최소 기준이다. 5회를 초과한 사용도 허용하며, 5회 초과 세션에도 동일한 다이어리를 적용한다. 사용 회차는 사용자가 선택하지 않고 Participant별 완료 세션의 완료 순서로 자동 계산한다. Participant와 Admin 화면에는 한도처럼 보이는 분모 없이 누적 횟수를 표시한다.

예:

```text
도구 사용 4회
다이어리 작성 4회
```

5회를 초과한 경우:

```text
도구 사용 7회
다이어리 작성 7회
```

Admin은 연구자가 최소 5회 충족 여부를 구분해 확인할 수 있도록 별도의 완료 여부 또는 상태를 표시할 수 있다.

연구 참여 완료 여부를 판단할 때는 별도로:

```text
completed session 5회 이상
+
각 session_id에 연결된 다이어리 제출
```

을 확인한다. 연구 회차는 사용자가 선택하지 않으며, Participant별 `completed` 세션을 `completed_at` 오름차순으로 정렬해 계산하고 시간이 같으면 `session.id` 오름차순을 보조 기준으로 사용한다. 최소 연구 참여 기준은 5회이고, 5회를 초과한 사용도 허용한다. 다이어리 상태는 각 세션과 별도로 저장한다.

---

# 10. 자동 저장 및 중단 세션

실제 디자인 작업 중 사용하는 도구이므로 사용자가 브라우저를 닫거나 다른 작업으로 이동할 가능성을 고려한다.

다음 데이터를 자동 저장한다.

- 입력 정보
- 질문
- 답변
- 질문 상태
- 건너뛰기
- 재생성
- 후속 질문
- 표현 정리 결과

사용자가 완료하지 않은 상태에서 종료하더라도 세션을 삭제하지 않는다.

다음 로그인 시 미완료 세션이 있다면 안내한다.

> 작성 중인 성찰이 있어요.  
> 이어서 진행할까요?

가능한 선택:

```text
[이어서 진행하기]
[새 성찰 시작하기]
```

미완료 세션은 History에서 `작성 중`으로 표시한다.

---

# 11. 이미지 업로드

## 지원 형식

```text
JPG
JPEG
PNG
```

PDF는 v1.0에서 지원하지 않는다.

## 제한

```text
최대 이미지 수: 10장
이미지당 최대 용량: 10MB
```

## 업로드 방법

다음을 모두 지원한다.

- Drag & Drop
- 컴퓨터에서 파일 선택
- Ctrl + V
- Cmd + V
- 여러 이미지 동시 업로드

## 질문 생성 전

사용자는 다음을 할 수 있다.

- 이미지 추가
- 이미지 삭제
- 이미지 교체
- 이미지 순서 변경

## 질문 생성 후

질문과 이미지 및 Pin의 관계를 보존하기 위해 해당 세션의 이미지 구성을 잠근다.

이미지를 잘못 등록한 경우 새로운 세션을 시작하도록 안내할 수 있다.

---

# 12. 디자인 분야 선택

구조:

```text
1차 분야
↓
2차 분야
```

2차 분야까지 **단일 선택**한다.

내부적으로는 화면 label과 stable ID를 분리하여 관리한다.

---

## 12.1 UX/UI

- 웹 디자인
- 모바일 앱 디자인
- 프로덕트 디자인
- 서비스 디자인
- 인터랙션 디자인
- 디자인 시스템
- 게임 UI/UX 디자인

---

## 12.2 브랜드 · 그래픽

- 브랜드 디자인(BI/CI)
- 그래픽 디자인
- 포스터 디자인
- 광고·캠페인 디자인
- 콘텐츠 디자인
- 인포그래픽·정보 디자인

---

## 12.3 편집 · 패키지

- 편집 디자인(인쇄물)
- 패키지 디자인

---

## 12.4 일러스트레이션 · 캐릭터

- 일러스트레이션
- 캐릭터 디자인
- 패턴 디자인
- 아이콘·픽토그램 디자인

---

## 12.5 영상 · 모션

- 영상 섬네일 디자인
- 영상 그래픽 디자인
- 모션 그래픽 디자인

---

## 12.6 제품 · 공간

- 제품 디자인
- 공간 디자인
- 전시 디자인
- 사이니지·환경 그래픽 디자인

---

## 12.7 기타

- 기타

기타 선택 시 직접 입력 필드를 표시한다.

---

# 13. 디자인 분야 데이터

```ts
export interface DesignSubcategory {
  id: string;
  label: string;
}

export interface DesignCategory {
  id: string;
  label: string;
  items: DesignSubcategory[];
}

export const DESIGN_CATEGORIES: DesignCategory[] = [
  {
    id: 'ux_ui',
    label: 'UX/UI',
    items: [
      { id: 'web_design', label: '웹 디자인' },
      { id: 'mobile_app_design', label: '모바일 앱 디자인' },
      { id: 'digital_product_design', label: '프로덕트 디자인' },
      { id: 'service_design', label: '서비스 디자인' },
      { id: 'interaction_design', label: '인터랙션 디자인' },
      { id: 'design_system', label: '디자인 시스템' },
      { id: 'game_ui_ux_design', label: '게임 UI/UX 디자인' },
    ],
  },
  {
    id: 'brand_graphic',
    label: '브랜드 · 그래픽',
    items: [
      { id: 'brand_design', label: '브랜드 디자인(BI/CI)' },
      { id: 'graphic_design', label: '그래픽 디자인' },
      { id: 'poster_design', label: '포스터 디자인' },
      {
        id: 'advertising_campaign_design',
        label: '광고·캠페인 디자인',
      },
      { id: 'content_design', label: '콘텐츠 디자인' },
      {
        id: 'information_design',
        label: '인포그래픽·정보 디자인',
      },
    ],
  },
  {
    id: 'editorial_package',
    label: '편집 · 패키지',
    items: [
      {
        id: 'editorial_print_design',
        label: '편집 디자인(인쇄물)',
      },
      { id: 'package_design', label: '패키지 디자인' },
    ],
  },
  {
    id: 'illustration_character',
    label: '일러스트레이션 · 캐릭터',
    items: [
      { id: 'illustration', label: '일러스트레이션' },
      { id: 'character_design', label: '캐릭터 디자인' },
      { id: 'pattern_design', label: '패턴 디자인' },
      {
        id: 'icon_pictogram_design',
        label: '아이콘·픽토그램 디자인',
      },
    ],
  },
  {
    id: 'video_motion',
    label: '영상 · 모션',
    items: [
      {
        id: 'video_thumbnail_design',
        label: '영상 섬네일 디자인',
      },
      {
        id: 'video_graphic_design',
        label: '영상 그래픽 디자인',
      },
      {
        id: 'motion_graphic_design',
        label: '모션 그래픽 디자인',
      },
    ],
  },
  {
    id: 'product_spatial',
    label: '제품 · 공간',
    items: [
      {
        id: 'industrial_product_design',
        label: '제품 디자인',
      },
      { id: 'spatial_design', label: '공간 디자인' },
      { id: 'exhibition_design', label: '전시 디자인' },
      {
        id: 'signage_environmental_graphic_design',
        label: '사이니지·환경 그래픽 디자인',
      },
    ],
  },
  {
    id: 'others',
    label: '기타',
    items: [
      { id: 'other', label: '기타' },
    ],
  },
];
```

주의:

`프로덕트 디자인`은 디지털 프로덕트이고  
`제품 디자인`은 물리적 제품 디자인이다.

내부 ID로 반드시 구분한다.

---

# 14. 현재 작업 단계

단일 선택한다.

UI 질문:

> 현재 작업 단계는 어디에 가까운가요?  
> 지금 작업물과 가장 가까운 단계를 선택해 주세요.

---

## 14.1 리서치·문제정의

내부 ID: `research_problem_definition`

사용자, 문제, 맥락 등을 탐색하고 문제를 정의하는 단계.

예:

- 사용자 리서치
- 문제정의 보고서
- 페르소나
- 사용자 여정
- 현황 분석

---

## 14.2 아이디어·컨셉

내부 ID: `idea_concept`

아이디어 및 디자인 방향을 탐색하는 단계.

예:

- 아이디어 스케치
- 컨셉 기획안
- 무드보드
- 방향성 보드

---

## 14.3 구조·설계

내부 ID: `structure_design`

정보, 기능, 흐름, 형태 등을 구조화하는 단계.

예:

- IA
- User Flow
- Wireframe
- Layout Structure
- 설계안

---

## 14.4 시각화·구체화

내부 ID: `visualization_specification`

설정한 방향과 구조를 실제 디자인 형태로 발전시키는 단계.

예:

- UI Mockup
- Graphic Concept
- Brand Concept
- Package Design
- Product Concept
- Spatial Concept

---

## 14.5 검토·개선

내부 ID: `review_improvement`

구체화된 디자인을 검토하고 수정하는 단계.

예:

- 수정안
- 개선안
- 최종 시안
- 디자인 검토 자료

---

# 15. 작업 단계의 AI 활용 방식

작업 단계는 단순한 사용자 분류값이 아니다.

AI가 질문의 **수준과 추상도**를 조절하는 데 활용한다.

예:

### 리서치·문제정의

완성된 시각 디자인을 평가하는 질문보다:

- 어떤 문제를 중요하게 보고 있는가?
- 현재 문제 정의에 포함되지 않은 사용자는 없는가?
- 이 문제를 문제라고 판단한 근거는 무엇인가?

등을 우선할 수 있다.

### 시각화·구체화

- 현재 시각적 위계가 의도와 어떻게 연결되는가?
- 특정 형태나 표현을 선택한 이유는 무엇인가?

처럼 구체적인 결과물을 대상으로 질문할 수 있다.

### 검토·개선

- 처음 설정한 목적과 현재 결과가 어떻게 연결되는가?
- 예상했던 결과와 실제 결과 사이에 차이가 있는가?

등의 질문을 우선할 수 있다.

---

# 16. 점검하고 싶은 부분

UI 제목:

> 점검하고 싶은 부분을 선택해주세요.

최대 **3개까지 복수 선택**한다.

선택지:

| 내부 ID | 선택지 |
| --- | --- |
| `problem_and_goal` | 문제와 목표를 다시 살펴보고 싶어요 |
| `design_concept` | 현재 디자인의 컨셉을 점검하고 싶어요 |
| `user_perspective` | 사용자의 관점에서 생각해보고 싶어요 |
| `information_element_structure` | 정보와 요소의 구조를 점검하고 싶어요 |
| `visual_form` | 시각적·형태적 표현을 살펴보고 싶어요 |
| `other_perspectives` | 다른 관점이나 가능성을 탐색하고 싶어요 |
| `decision_reasoning` | 내 판단의 이유와 근거를 점검하고 싶어요 |
| `intent_alignment` | 현재 결과가 의도에 맞는지 확인하고 싶어요 |
| `next_steps` | 다음 단계에서 무엇을 시도할지 생각해보고 싶어요 |

작업 단계와 점검 맥락 ID는 애플리케이션 stable ID 상수로 관리하며, DB lookup table을 추가하지 않는다. 저장된 연구 데이터와의 호환성을 위해 ID를 변경하지 않는다.

---

# 17. 점검 맥락 사용 규칙

점검하고 싶은 부분은 AI 질문을 제한하는 절대 조건이 아니라 **질문 생성의 힌트**로 사용한다.

예를 들어 사용자가:

```text
사용자의 관점에서 생각해보고 싶어요
시각적·형태적 표현을 살펴보고 싶어요
```

를 선택했다고 해서 모든 질문을 두 영역에서만 생성하지 않는다.

다만 다음 조건은 만족해야 한다.

> 생성된 최초 질문 중 최소 1개 이상은 사용자가 선택한 점검 맥락과 직접 연결되어야 한다.

나머지 질문은 이미지와 디자인 맥락, 작업 단계, 질문 프레임워크를 종합하여 성찰 가치가 높은 내용을 탐색할 수 있다.

---

# 18. 추가 설명

선택 입력.

UI:

> AI가 질문을 만드는 데 참고하면 좋을 작업 배경이나 고민이 있다면 자유롭게 적어주세요.

예:

```text
현재 메인 화면의 정보 구조를 수정하고 있습니다.
사용자가 처음 들어왔을 때 어떤 기능부터 보게 해야 할지 고민 중입니다.
```

---

# 19. 질문 수

사용자가 생성할 최초 질문 수를 선택한다.

```text
기본값: 3
최소: 1
최대: 5
```

---

# 20. 질문 생성 프레임워크

WHY BOX의 질문은 다음 프레임워크를 기반으로 생성한다.

---

# 20.1 질문 내용 원리

## 1. 사고의 자각과 외재화

### 목적

명확히 인식되지 않은 자신의 앎과 판단을 자각하고 다양한 방식으로 표현하여 스스로 확인할 수 있도록 한다.

### 세부 분류

- 자기인식 질문
- 사고 외재화 질문
- 언어화 질문
- 시각화 질문

---

## 2. 사고의 근거와 구조 검토

### 목적

현재 판단을 구성하는 목적, 근거, 전제, 관계를 구체적으로 확인하고 사고의 타당성을 검토하도록 한다.

### 세부 분류

- 의도 및 판단 근거 질문
- 가정 탐색 질문
- 개념 명료화 질문
- 관계 탐색 질문
- 결과 예상 질문
- 사고 점검 질문

---

## 3. 사고의 확장과 재구성

### 목적

기존의 관점과 문제 경계를 벗어나 사용자, 경험, 맥락, 시스템을 폭넓게 탐색하고 새로운 관점에서 문제와 사고를 재구성하도록 한다.

### 세부 분류

- 문제 재구성 질문
- 사용자 및 맥락 확장 질문
- 경험 및 사례 연결 질문
- 제약 재검토 질문
- 해결방식 재검토 질문
- 상충 관점 질문
- 시스템 관점 질문
- 우선순위 질문

---

## 4. 탐색적 실험과 검증

### 목적

다양한 해결 가능성을 구체화하고 실제 시도와 외부 표현을 통해 결과를 관찰함으로써 아이디어, 문제 이해, 해결안을 발전시키도록 한다.

### 세부 분류

- 대안 생성 질문
- 해결안 구체화 질문
- 실험 및 프로토타이핑 질문
- 가치 및 적합성 검토 질문

---

## 5. 자기점검과 조절

### 목적

자신의 수행 과정, 결과, 상황을 지속적으로 관찰하고 평가하여 목표, 전략과 이후 행동을 조정하도록 한다.

### 세부 분류

- 수행 모니터링 질문
- 자기변화 관찰 질문
- 예상 및 결과 비교 질문
- 행동 및 반응 관찰 질문
- 목표 및 전략 조절 질문

---

# 20.2 질문 구조 원리

## 1. 응답 기반 연쇄적 질문

### 목적

사용자의 응답을 완결된 답으로 처리하지 않고 사고를 발전시킬 단서로 활용하여 선행 및 후속 질문을 연결하고 사고를 점진적으로 심화한다.

### 세부 분류

- 응답 탐색
- 응답 명료화
- 후속 질문 연결

---

## 2. 자기탐색 유도 질문

### 목적

직접적인 평가 및 해결책을 제공하기보다 질문을 통해 사용자가 자신의 의도와 판단 그리고 사고과정을 스스로 탐색하도록 한다.

### 세부 분류

- 비지시적 질문
- 개방형 질문
- 자기판단 유도 질문

---

## 3. 체계적이고 유연한 질문

### 목적

질문의 목적과 성격을 고려하여 질문을 체계적으로 구성하되 사용자의 응답과 작업 맥락에 따라 질문의 방향, 순서, 수준을 유연하게 조정한다.

### 세부 분류

- 목적 및 적합성 점검
- 질문 유형 선택
- 질문 순서 조정
- 질문 수준 조정

---

# 21. 최초 질문 생성 입력

AI는 다음 정보를 함께 사용한다.

```text
1. 업로드 이미지 1~10장
2. 디자인 1차 분야
3. 디자인 2차 분야
4. 현재 작업 단계
5. 점검하고 싶은 부분 최대 3개
6. 추가 설명
7. 요청 질문 수
8. WHY BOX 질문 생성 프레임워크
```

---

# 22. 최초 질문 생성 규칙

AI는 다음 규칙을 따른다.

1. 디자인 분야에 맞는 맥락으로 이미지를 해석한다.
2. 현재 작업 단계에 적합한 수준의 질문을 생성한다.
3. 선택된 점검 맥락이 있다면 최소 1개의 질문은 해당 맥락과 직접 연결한다.
4. 이미지에서 관찰할 수 있는 구체적인 단서를 가능한 한 활용한다.
5. 서로 동일하거나 사실상 같은 질문을 반복하지 않는다.
6. 사용자의 디자인을 직접 평가하지 않는다.
7. 해결책을 암시하거나 특정 답변으로 유도하지 않는다.
8. 사용자가 자신의 의도와 판단을 설명하도록 한다.
9. 한 질문에 너무 많은 내용을 동시에 묻지 않는다.
10. 개방형 질문을 우선한다.
11. 질문 생성 프레임워크의 내용 원리와 구조 원리를 따른다.

---

# 23. 여러 이미지 처리

업로드 이미지가 여러 장이어도 이미지당 질문을 하나씩 생성하지 않는다.

AI는 모든 이미지를 함께 확인한 후 요청된 질문 수만큼 가장 의미 있는 질문을 생성한다.

예:

```text
업로드 이미지: 8장
질문 수: 3개
```

이라고 하더라도 8개의 이미지에 각각 질문을 만들 필요가 없다.

AI가 질문에 적합한 이미지 또는 이미지 영역을 선택한다.

---

# 24. Question Target

각 질문에는 질문이 가리키는 대상을 저장한다.

세 종류:

```text
region
image
multi_image
```

---

## 24.1 region

특정 이미지의 특정 영역에 대한 질문.

저장:

```text
image_id
x
y
width
height
```

좌표는 가능하면 이미지 원본 크기에 종속되지 않는 normalized value를 사용한다.

예:

```json
{
  "x": 0.32,
  "y": 0.41,
  "width": 0.18,
  "height": 0.12
}
```

화면에서는 해당 영역에 질문 Pin을 표시한다.

---

## 24.2 image

특정 이미지 전체에 대한 질문.

화면에서는:

- 이미지 전체 영역 강조
- 이미지 좌측 상단 등 고정 위치에 Pin/Badge
- `전체` 표시 가능

---

## 24.3 multi_image

여러 이미지의 비교 또는 관계를 대상으로 하는 질문.

저장:

```text
image_ids[]
```

화면에서는 관련 이미지를 모두 강조하고 대상 이미지를 명확하게 표시한다.

예:

```text
이미지 1 · 이미지 3
```

---

# 25. AI Structured Output

질문 생성 결과는 가능한 한 JSON Schema 기반의 구조화된 형태로 반환한다.

예:

```json
{
  "question_text": "현재 가장 먼저 보이도록 구성한 요소는 무엇이며, 그렇게 판단한 이유는 무엇인가요?",
  "content_principle": "사고의 근거와 구조 검토",
  "detail_type": "의도 및 판단 근거 질문",
  "selected_context_ids": [
    "information_element_structure"
  ],
  "target": {
    "type": "region",
    "image_ids": [
      "img_02"
    ],
    "x": 0.32,
    "y": 0.41,
    "width": 0.18,
    "height": 0.12
  },
  "selection_reason": "선택한 맥락과 화면의 시각적 위계가 직접 관련됨"
}
```

---

# 26. AI 연구 메타데이터

각 질문마다 다음 정보를 저장한다.

```text
question_text
content_principle
detail_type
selected_context
work_stage
target_type
target_image_ids
target_coordinates
selection_reason
model_id
prompt_version
framework_version
generated_at
```

`selection_reason`은 연구 분석을 위한 **짧고 명시적인 선택 근거**만 저장한다.

AI의 내부 chain-of-thought은 요청하거나 저장하지 않는다.

---

# 27. 질문 화면

질문 생성 후 화면은 기본적으로:

```text
[ 디자인 이미지 / Pin ]
        |
        |
[ 질문 및 답변 Panel ]
```

형태로 구성한다.

사용자는 다음 방식으로 질문을 이동할 수 있다.

- 이미지 Pin 선택
- 질문 목록 선택
- 이전 질문
- 다음 질문

질문 상태를 확인할 수 있어야 한다.

예:

```text
Q1 답변 완료 ✓
Q2 건너뜀 ✓
Q3 아직 확인하지 않음
```

---

# 28. 답변

각 질문에는 자유 서술형 답변창을 제공한다.

답변은 자동 저장한다.

주요 데이터:

```text
original_answer
refined_answer
refinement_used
answered_at
updated_at
```

각 다이어리는 해당 세션의 `session_id`에 연결한다. 한 세션에는 최대 하나의 다이어리 기록을 둔다. 다이어리 제출 여부는 세션 완료 여부와 독립적으로 관리한다.

사용자의 최초 작성 내용은 반드시 원문으로 보존한다.

---

# 29. 표현 정리하기

답변 작성 후 선택적으로 사용할 수 있다.

기능명:

> 표현 정리하기

설명:

> 작성한 내용의 의미는 변경하지 않고 문장을 읽기 쉽게 정리합니다.

---

## 29.1 UI

큰 Submit CTA처럼 보이지 않도록 한다.

예:

```text
↻ 표현 정리하기
```

또는 작은 원형 아이콘 버튼을 사용할 수 있다.

---

## 29.2 동작

사용자가 작성한 답변을 AI에 전달한다.

AI는:

- 문장 구조
- 표현
- 가독성

정도만 정리한다.

금지:

- 새로운 아이디어 추가
- 사용자의 의도 추정 후 내용 추가
- 디자인 평가
- 조언 추가
- 해결책 추가

---

## 29.3 결과 표시

정리 결과는 기존 입력 영역에서 자연스럽게 전환하여 보여줄 수 있다.

변경된 표현을:

- Bold
- Highlight
- Shade

등으로 표시할 수 있다.

필요 시:

```text
원문 보기
정리된 문장 사용
```

기능을 제공한다.

---

## 29.4 데이터

원문은 절대 overwrite하지 않는다.

```text
original_answer
refined_answer
refinement_used
refined_at
```

을 각각 저장한다.

---

# 30. 후속 질문

최초 질문에 답변한 후 사용자가 원할 경우 후속 질문을 받을 수 있다.

### 제한

최초 질문 1개당 최대:

```text
2개
```

의 후속 질문을 생성할 수 있다.

---

## 30.1 후속 질문 목적

사용자의 답변을 평가하는 것이 아니다.

답변에서 발견된 내용을 바탕으로:

- 더 구체적으로 생각하기
- 의미 명료화하기
- 근거 탐색하기
- 다른 관점 탐색하기
- 생각 확장하기

등을 돕는다.

---

## 30.2 후속 질문 규칙

AI는 다음과 같이 행동한다.

```text
사용자의 응답을 정답이나 오답으로 평가하지 않는다.
응답에서 추가적으로 탐색할 수 있는 사고의 단서를 찾는다.
그 단서를 기반으로 하나의 후속 질문을 생성한다.
```

후속 질문은 세션 완료를 위한 필수 항목이 아니다.

---

# 31. 질문 건너뛰기

사용자는 최초 질문에 답변하지 않고 건너뛸 수 있다.

버튼:

> 건너뛰기

선택적으로 이유를 받을 수 있다.

- 현재 작업과 관련이 없어요
- 이미 충분히 생각해본 내용이에요
- 질문을 이해하기 어려워요
- 답변하기 어려워요
- 기타

건너뛰더라도 기존 질문을 삭제하지 않는다.

저장:

```text
question_id
skip_reason
skipped_at
```

---

# 32. 질문 다시 생성

사용자는 현재 질문이 적절하지 않은 경우 질문을 다시 생성할 수 있다.

재생성은 답변이 작성되지 않은 현재 active 질문에서만 가능하다. 이미 답변이 작성된 active 질문은 재생성할 수 없다.

최초 질문 슬롯 1개당 최대:

```text
2회
```

---

## 32.1 재생성 이유

선택 입력.

- 현재 작업과 관련이 없어요
- 이미 충분히 생각해본 내용이에요
- 질문을 이해하기 어려워요
- 답변하기 어려워요
- 다른 관점의 질문을 받아보고 싶어요
- 기타

---

## 32.2 데이터 보존

재생성된 질문이 기존 질문을 overwrite해서는 안 된다.

반드시 다음 chain을 보존한다.

```text
최초 질문
↓
재생성 질문 1
↓
재생성 질문 2
```

각 질문은 고유 ID를 가진다.

현재 활성화된 질문 버전만 사용자에게 기본 표시하되 관리자 연구 로그에서는 전체 이력을 확인할 수 있어야 한다.

### 질문 계보 및 활성 버전 규칙

각 질문 버전은 다음 관계를 가진다.

| 질문 종류 | `root_question_id` | `parent_question_id` | 기타 규칙 |
|---|---|---|---|
| 최초 질문 (`original`) | 자기 자신의 `question_id` | `null` | `regeneration_index = 0` |
| 재생성 질문 (`regenerated`) | 해당 슬롯의 최초 질문 ID | 바로 이전 질문 버전 ID | `regeneration_index = 이전 버전 + 1` |
| 후속 질문 (`followup`) | 해당 최초 질문 ID | 후속 질문을 생성하게 한 직전 질문 ID | `followup_index`는 1 또는 2 |

- 재생성 이후 작성한 답변은 답변 당시 active인 질문 버전의 `question_id`에 연결한다.
- 각 최초 질문 슬롯에는 active version이 정확히 하나만 존재할 수 있다.
- 재생성은 최초 질문 슬롯당 최대 2회다.
- 후속 질문은 최초 질문 root당 최대 2개다.
- 기존 질문 버전과 답변은 이력 보존을 위해 삭제하거나 덮어쓰지 않는다.

---

# 33. 디자인 성찰 요약 보기

질문 화면에서 사용자가 세션의 진행 상태를 확인할 수 있도록 한다.

예:

```text
질문 2/3 확인 · 1개 남음
```

모든 최초 질문 슬롯의 현재 active version이 처리되기 전에는:

```text
디자인 성찰 요약 보기
```

버튼을 비활성 상태로 표시한다.

---

## 33.1 활성화 조건

다음을 모두 만족할 때 활성화한다.

```text
모든 최초 질문 슬롯의 현재 active version = answered 또는 skipped
AND
최소 1개의 active version = answered
```

---

## 33.2 활성화 UI

조건을 충족하면 버튼을 시각적으로 강조한다.

가능:

- 약한 Glow
- Light sweep
- 2~3회 정도의 짧은 Motion

금지:

- 계속 깜빡이는 Animation
- 지나치게 강한 Motion

카피:

> 모든 질문을 확인했어요!  
> 답변 내용을 바탕으로 이번 작업에서 생각한 내용을 정리해볼 수 있어요.

CTA:

> ✨ 디자인 성찰 요약 보기 →

---

# 34. 디자인 성찰 요약본

사용자가 `디자인 성찰 요약 보기`를 선택하면 해당 세션의 답변을 기반으로 요약을 생성한다. 생성에 실패하면 세션은 `summary_ready` 상태를 유지하고 재시도할 수 있다. 생성 결과를 저장한 경우에만 `completed`로 전이한다.

명칭:

> 디자인 성찰 요약본

---

## 34.1 요약 원칙

AI는 **사용자가 실제로 작성한 답변만 재구성**한다.

핵심 instruction:

> 새로운 평가·조언·해결책을 추가하지 말고 사용자가 작성한 응답만 재구성한다.

---

## 34.2 권장 구성

### 이번 작업에서 중요하게 생각한 것

사용자가 질문에 답하면서 반복적으로 언급한 목적, 기준, 중요 요소 등을 정리한다.

### 질문을 통해 새롭게 확인한 것

사용자가 질문에 답하는 과정에서 새롭게 인식하거나 다시 생각한 내용을 정리한다.

### 다음 작업에서 확인해볼 것

사용자가 자신의 답변에서 직접 언급한 다음 행동, 확인할 내용, 검토할 부분이 있을 경우에만 정리한다.

사용자 답변에 없는 내용을 AI가 임의로 만들어서는 안 된다.

---

# 35. 세션 완료

디자인 성찰 요약 생성 및 저장이 성공하면:

```text
session.status = completed
session.completed_at = timestamp
```

으로 변경한다.

요약 생성 실패 시에는 `summary_ready`를 유지하고 재시도할 수 있다. `completed`로 전이한 뒤 요약 화면을 표시한다.

이 시점을:

> 도구 사용 1회 완료

로 정의한다.

---

# 36. 사용 다이어리

성찰 요약 확인 직후 사용 다이어리를 표시한다.

다이어리는 모든 사용 회차에 동일한 문항을 사용한다. 5회 초과 세션에도 동일하게 적용한다.

3회차, 5회차 등의 별도 추가 문항은 사용하지 않는다.

---

## Q1. 이번 질문을 통해 어떤 경험을 했나요?

응답 방식:

```text
복수 선택
필수
```

선택지:

- 생각이 더 구체적으로 정리되었다
- 미처 생각하지 못한 부분을 발견했다
- 다른 관점이나 가능성을 생각해보았다
- 내 판단의 이유나 근거를 다시 생각해보았다
- 현재 디자인을 다시 점검해보게 되었다
- 다음에 무엇을 할지 생각해보게 되었다
- 특별한 변화는 없었다

### 선택 로직

`특별한 변화는 없었다`를 선택하면 다른 항목과 동시에 선택할 수 없도록 한다.

---

## Q2. 이번 사용에서 느낀 점을 선택해주세요.

응답 방식:

```text
복수 선택
필수
```

선택지:

- 흥미로웠어요
- 새로웠어요
- 도움이 되었어요
- 생각하기 어려웠어요
- 부담스러웠어요
- 답답했어요
- 특별한 느낌이 없었어요

### 선택 로직

`특별한 느낌이 없었어요`를 선택하면 다른 항목과 동시에 선택할 수 없도록 한다.

---

## Q3. 이번 사용에서 기억에 남는 점이 있다면 자유롭게 남겨주세요.

응답 방식:

```text
서술형
선택
```

---

# 37. 다이어리 상태

다이어리는 세션과 별도로 다음 상태를 가진다.

```text
not_started
submitted
```

제출 시:

```text
diary.submitted_at
```

을 기록한다.

---

# 38. Participant History

## Participant 홈

Participant 홈에는 연구 진행 상태만 간단하게 표시한다. Admin용 세부 연구 데이터와 다른 참여자의 정보는 노출하지 않는다.

예:

```text
도구 사용 4회
사용 다이어리 4회
작성 중인 성찰이 1개 있어요. [이어서 작성하기]
```

도구 사용 횟수는 완료된 세션 수, 다이어리 횟수는 해당 완료 세션에 연결된 제출 다이어리 수를 기준으로 표시한다. 5회를 초과한 경우에도 추가 사용은 허용한다.

## 과거 기록

참여자는 자신의 과거 사용 기록을 볼 수 있다.

완료된 세션에는 다음 정보를 표시한다.

- 사용 날짜
- 디자인 분야
- 작업 단계
- 대표 이미지 Thumbnail
- 질문
- 자신의 답변
- 디자인 성찰 요약본

완료된 기록은:

```text
READ ONLY
```

로 제공한다.

수정할 수 없다.

미완료 세션은:

```text
작성 중
```

상태로 표시하고 이어서 진행할 수 있다.

---

# 39. Compact View

WHY BOX는 웹 기반이지만 사용자가 Figma, Illustrator 등 디자인 프로그램 옆에 브라우저를 배치해서 사용할 수 있도록 좁은 화면을 지원한다.

---

## Desktop

권장 구조:

```text
┌────────────────────────────┬───────────────────┐
│                            │                   │
│      디자인 이미지         │      질문         │
│      + Pin Canvas          │      답변         │
│                            │                   │
│                            │   보조 기능        │
│                            │                   │
└────────────────────────────┴───────────────────┘
```

---

## Compact View

약:

```text
360px ~ 440px
```

너비에서 사용 가능하도록 한다.

권장 흐름:

```text
현재 이미지 / Thumbnail
↓
질문
↓
답변
↓
표현 정리 / 후속 질문
↓
이전 / 다음
```

v1.0에서는 다음을 구현하지 않는다.

- OS-level Always On Top
- Native Floating Window
- Desktop App

---

# 40. Admin Dashboard

관리자 화면에서 참여자별 진행 현황을 한눈에 확인한다.

예:

```text
P10 | P | Active | 도구 사용 5회 | 다이어리 작성 5회 | 연구 기준 충족 | 최근 사용 10/03
P11 | P | Active | 도구 사용 4회 | 다이어리 작성 4회 | 최근 사용 10/02
P01 | T | Active | 도구 사용 1회 | 다이어리 작성 1회 | 연구 통계 제외 | 최근 사용 10/11
```

Admin 화면에서는 한도처럼 보이는 `n/6` 형식 대신 다음처럼 누적 횟수를 표시한다.

```text
P10 | P | Active | 도구 사용 7회 | 다이어리 작성 7회 | 연구 기준 충족 | 최근 사용 10/03
```

Admin은 5회를 초과한 경우를 포함한 전체 사용 횟수와 최소 5회 기준 충족 여부를 확인할 수 있어야 한다. 연구 회차는 Participant별 완료 세션의 `completed_at` 오름차순으로 계산하고, 동률이면 `session.id` 오름차순을 보조 기준으로 사용하며 사용자가 입력하지 않는다.

---

# 41. 참여자 계정 관리

관리자는 다음 기능을 가진다.

- 참여자 계정 생성
- 참여자 코드 설정
- P/T 유형 명시적 선택·필터·확인 후 변경 및 변경 이력
- 정보 수정
- 계정 비활성화
- 임시 비밀번호 재설정

연구 데이터가 이미 존재하는 참여자는 가능하면 실제 삭제하지 않는다.

---

# 42. Admin Session Detail

각 세션에서 다음 데이터를 확인할 수 있어야 한다.

### 기본 정보

```text
participant_code
session_id
session_status
started_at
completed_at
```

### 디자인 정보

```text
primary_category
subcategory
work_stage
reflection_contexts
additional_context
requested_question_count
```

### 이미지

```text
image_id
image_order
storage_path
uploaded_at
```

### 질문

```text
question_id
question_text
question_kind
content_principle
detail_type
target_type
target_image
target_coordinates
selection_reason
question_status
```

### 응답

```text
original_answer
refined_answer
refinement_used
answered_at
```

### 기타 상호작용

```text
skip
skip_reason
regeneration
regeneration_reason
followup_questions
```

### AI 정보

```text
model_id
prompt_version
framework_version
generated_at
```

### 결과

```text
reflection_summary
diary
```

---

# 43. CSV Export

관리자는 연구 분석을 위해 데이터를 CSV로 export할 수 있다.

권장 파일:

```text
participants.csv
sessions.csv
questions.csv
answers.csv
followups.csv
diaries.csv
```

필요한 관계 Key:

```text
participant_id
session_id
question_id
root_question_id
parent_question_id
```

이미지 자체를 CSV에 포함하지 않는다.

대신:

```text
image_id
storage_path
```

를 저장한다.

---

# 44. 권장 DB 구조

다음 entity 구조를 권장한다.

```text
profiles
sessions
session_contexts
session_images
questions
question_targets
answers
question_events
diaries
error_logs
```

---

# 45. profiles

예시 필드:

```text
id
participant_code
role
account_type
status
created_at
updated_at
```

account_type (권한과 별도, Migration 승인·적용 이후):

```text
P: 실제 연구 참여자
T: 검토·테스트 사용자
NULL: 미분류 또는 관리자 (연구 집계 제외)
```

기존 계정에는 기본 P 값을 부여하지 않는다. `account_type_events`에 유형 변경 전/후 값, 변경자, 사유, 시각을 보존한다.

role:

```text
participant
admin
```

status:

```text
active
deactivated
```

---

# 46. sessions

주요 필드:

```text
id
participant_id
status

primary_category_id
subcategory_id
other_category_text

stage_id
additional_context

requested_question_count

summary_text

model_id
prompt_version
framework_version

started_at
completed_at
created_at
updated_at
```

연구 회차는 별도 입력 필드로 저장하지 않는다. Participant별 `completed` 세션을 `completed_at` 오름차순으로 정렬하고, 동률이면 `session.id` 오름차순을 보조 기준으로 사용한다. 연구 참여 기준은 최소 5회이며 완료 횟수 상한은 없다.

---

# 47. session_contexts

점검하고 싶은 부분은 복수 선택이므로 별도 relation 권장.

```text
id
session_id
context_id
created_at
```

---

# 48. session_images

```text
id
session_id
storage_path
original_filename
mime_type
file_size
width
height
sort_order
created_at
```

---

# 49. questions

권장 필드:

```text
id
session_id

root_question_id
parent_question_id

question_kind
slot_index

regeneration_index
followup_index

question_text

content_principle
detail_type

target_type
selection_reason

status
is_active_version

skip_reason

model_id
prompt_version
framework_version

created_at
answered_at
skipped_at
```

`question_kind` 예:

```text
original
regenerated
followup
```

계보 규칙:

- `original`: `root_question_id`는 자기 `question_id`, `parent_question_id`는 `null`, `regeneration_index = 0`.
- `regenerated`: `root_question_id`는 슬롯의 최초 질문 ID, `parent_question_id`는 바로 이전 버전 ID, `regeneration_index`는 이전 버전보다 1 큰 값.
- `followup`: `root_question_id`는 최초 질문 ID, `parent_question_id`는 후속 질문을 유발한 직전 질문 ID, `followup_index`는 1 또는 2.
- 최초 질문 슬롯마다 active version은 정확히 하나만 존재한다. 재생성 이후 답변은 답변 당시 active version의 `question_id`에 연결한다.
- 답변이 있는 active 질문은 재생성할 수 없다. 재생성은 최초 질문 슬롯당 최대 2회, 후속 질문은 최초 질문 root당 최대 2개다.
- 질문 이력을 보존하며 기존 버전이나 답변을 삭제/덮어쓰지 않는다.

---

# 50. question_targets

질문과 이미지 대상 관계.

```text
id
question_id
image_id

x
y
width
height

sort_order
created_at
```

`multi_image` 질문은 여러 row를 가질 수 있다.

---

# 51. answers

```text
id
question_id
participant_id

original_answer
refined_answer

refinement_used
refined_at

created_at
updated_at
```

후속 질문의 답변 역시 question_id를 통해 연결할 수 있다.

---

# 52. question_events

질문과 관련된 연구용 상호작용 로그.

예:

```text
question_opened
answer_started
answer_saved
answer_refined
question_skipped
question_regenerated
followup_requested
```

필드 예:

```text
id
session_id
question_id
participant_id
event_type
event_data
created_at
```

이 테이블은 사용자 행동의 모든 키 입력을 기록하는 용도가 아니다.

연구에 필요한 주요 상호작용만 저장한다.

---

# 53. diaries

```text
id
session_id
participant_id

experience_choices_json
feeling_choices_json
free_text

status
submitted_at
created_at
updated_at
```

`status`는 `not_started` 또는 `submitted`를 사용한다. `session_id`는 다이어리별로 유일해야 한다. 다이어리 제출 여부는 세션 완료와 독립적으로 관리한다.

---

## 53.1 error_logs

외부 오류 로그 서비스는 v1.0에서 사용하지 않는다. Participant 안내 정보와 내부 오류 상세를 분리해 저장한다.

```text
id
error_code
error_type
participant_id
session_id
related_question_id
internal_error_message
retryable
occurred_at
```

`error_type`은 `AUTH`, `UPLOAD`, `AI`, `SAVE`, `NETWORK`, `UNKNOWN` 중 하나다. 내부 로그는 Admin만 조회할 수 있고, Participant는 이 테이블에 직접 접근할 수 없다.

---

# 54. Autosave

다음 항목은 가능한 한 자동 저장한다.

- 세션 생성
- 이미지 등록
- 입력 정보
- 질문 생성 결과
- 질문 상태
- 답변
- 건너뛰기
- 질문 재생성
- 표현 정리 결과
- 후속 질문 및 응답
- 성찰 요약
- 세션 완료
- 다이어리

답변 입력은 적절한 debounce를 적용할 수 있다.

예:

```text
500~1000ms
```

또는 focus out 시 추가 저장한다.

---

# 55. 연구 데이터 보존 원칙

연구 과정에서 생성된 기존 데이터를 새로운 값으로 덮어써서 삭제하지 않는다.

특히 다음 항목은 원본을 보존한다.

```text
최초 질문
재생성 이전 질문
사용자의 원본 답변
표현 정리 이전 답변
건너뛰기 기록
후속 질문
```

즉,

> 현재 UI에서 무엇을 보여줄 것인가와  
> 연구 DB에서 무엇을 보존할 것인가는 구분한다.

---

# 56. Error Handling

## 이미지 업로드 실패

- 실패한 파일을 명확하게 표시
- 성공한 이미지까지 초기화하지 않음
- 실패 파일만 재시도 가능

---

## 질문 생성 실패

다음 데이터를 유지한다.

- 이미지
- 디자인 분야
- 작업 단계
- 점검 맥락
- 추가 설명
- 질문 수
- session

사용자는 다시 질문 생성을 요청할 수 있다.

---

## 성찰 요약 생성 실패

기존 질문과 답변을 유지한다.

요약 생성 실패 시:

```text
session.status = summary_ready
```

를 유지하고 사용자가 다시 시도할 수 있다. 요약 생성 및 저장 성공 시에만 `completed`로 변경한다.

---

## 네트워크 오류 / 브라우저 종료

마지막으로 성공적으로 저장된 상태에서 세션을 복구한다.

## Participant 오류 안내와 연구자 문의

연구 참여 중 오류가 발생하면 Participant가 문제 유형과 기본 대응 방법을 이해할 수 있도록 안내한다. Participant 화면에는 이해하기 쉬운 메시지, 오류 코드, 기본 대응 방법을 표시하며 API 응답 전문, stack trace, API key 및 기타 내부 기술/보안 정보는 노출하지 않는다.

오류 유형은 최소한 다음 값을 사용한다.

```text
AUTH
UPLOAD
AI
SAVE
NETWORK
UNKNOWN
```

표시 예:

> AI 질문 생성 중 오류가 발생했습니다. (AI-001)  
> 잠시 후 다시 시도해주세요.  
> 문제가 계속되면 연구자에게 오류 코드를 알려주세요.

재시도가 가능한 오류에는 다시 시도할 수 있는 UI를 제공한다. 오류가 발생해도 이미 저장된 세션, 이미지, 질문, 답변 데이터는 삭제하지 않는다.

서버/Admin 측 오류 기록은 Participant 표시 메시지와 분리하고, 연구자가 문의 원인을 확인할 수 있도록 최소 다음 필드를 제공한다.

```text
error_code
error_type
participant_id
session_id
related_question_id
internal_error_message
retryable
occurred_at
```

`related_question_id`는 해당 사항이 없으면 비어 있을 수 있다. 내부 오류 메시지는 관리자/개발자만 접근할 수 있어야 한다.

v1.0에서는 외부 오류 로그 서비스를 사용하지 않고 `error_logs` DB 테이블에 오류를 기록한다. `error_type`은 `AUTH`, `UPLOAD`, `AI`, `SAVE`, `NETWORK`, `UNKNOWN`으로 고정한다. 세부 `error_code`, Participant 안내 문구, `retryable` 값은 기능 구현 시 오류 catalog에서 함께 정의한다.

---

# 57. Loading Copy

## 질문 생성

> 작업물을 살펴보고 질문을 만들고 있어요…

## 표현 정리

> 작성한 표현을 정리하고 있어요…

## 후속 질문

> 답변을 바탕으로 다음 질문을 생각하고 있어요…

## 성찰 요약

> 이번에 나눈 생각을 정리하고 있어요…

---

# 58. Privacy / Security

- 연구 참여자는 P01, P02 등의 참여자 코드를 중심으로 관리한다.
- participant는 자신의 데이터만 조회할 수 있다.
- Admin만 전체 연구 데이터에 접근할 수 있다.
- Supabase RLS를 적용한다.
- Storage 이미지 접근 권한을 제한한다.
- API Secret을 클라이언트에 노출하지 않는다.
- 완료된 연구 데이터는 일반 참여자가 수정할 수 없다.
- 데이터 관계 보존을 위해 hard delete보다 soft delete / deactivate를 우선한다.

---

# 59. 연구 참여 안내에 포함할 완료 기준

참여자에게 다음과 같이 안내할 수 있다.

> 현재 표시 중인 질문에 답변하기 어려운 경우 ‘건너뛰기’를 선택해 주세요.  
> 모든 질문을 확인한 후에는 반드시 ‘디자인 성찰 요약 보기’까지 진행해 주세요.  
> 모든 최초 질문 슬롯의 현재 질문을 확인하고 성찰 요약 생성 및 저장이 성공하면 1회의 도구 사용이 완료된 것으로 기록됩니다.

추가로 최소 1개의 최초 질문 슬롯의 현재 active version에 직접 답변해야 한다.

---

# 60. v1.0 Out of Scope

다음 기능은 WHY BOX v1.0 MVP에서 제외한다.

- 공개 회원가입
- 소셜 로그인
- 복잡한 비밀번호 찾기
- PDF 업로드
- 동영상 업로드
- Figma Plugin
- Native App
- Always On Top
- AI 디자인 점수
- AI 디자인 등급
- AI가 생성하는 수정 시안
- AI가 직접 제공하는 디자인 해결책
- AI의 직접적인 디자인 평가
- 질문별 좋아요/싫어요
- 참여자용 복잡한 통계 Dashboard
- 과도한 관리자 검색/필터 기능

---

# 61. 개발 우선순위

## P0 — 연구 전 반드시 구현

- Authentication
- Participant/Admin role
- 참여자 계정 관리
- Session
- 이미지 업로드
- 디자인 분야
- 작업 단계
- 점검 맥락
- 추가 설명
- 질문 수
- AI 질문 생성
- Structured Output
- Question Target
- Pin
- 답변
- Autosave
- 건너뛰기
- 질문 재생성 최대 2회
- 후속 질문 최대 2회
- 표현 정리하기
- 성찰 요약
- 세션 완료 판정
- 최소 답변 조건
- 중단 세션 복구
- 다이어리
- Participant History
- Admin Progress
- Admin Session Detail
- CSV Export
- RLS / Security

---

## P1 — 핵심 구현 후

- 표현 정리 변경 부분 Highlight
- Pin Micro Interaction
- 성찰 요약 CTA Light Motion
- Compact View 세부 최적화
- Admin Filter
- 기타 UI Polish

---

# 62. Acceptance Test A — 정상 세션

다음 흐름이 오류 없이 가능해야 한다.

```text
P01 로그인
↓
이미지 3장 업로드
↓
UX/UI
↓
모바일 앱 디자인
↓
구조·설계
↓
점검 맥락 2개 선택
↓
질문 3개 생성
↓
Q1 답변
↓
표현 정리 사용
↓
Q1 후속 질문 1개
↓
Q2 답변
↓
Q3 건너뛰기
↓
모든 최초 질문 슬롯의 현재 active version 처리
↓
디자인 성찰 요약 보기 활성화
↓
성찰 요약 생성
↓
Session Completed
↓
사용 다이어리 제출
```

관리자:

```text
P01
도구 사용 1
다이어리 1
```

로 표시되어야 한다.

---

# 63. Acceptance Test B — 질문 재생성

```text
Q2 생성
↓
질문 다시 생성
↓
새 Q2 생성
↓
새 Q2 답변
```

관리자 데이터에는:

```text
Original Q2
Regenerated Q2-1
```

이 모두 남아 있어야 한다.

각 질문 버전의 root/parent/index 값은 질문 계보 규칙을 만족해야 한다. 재생성 후 답변은 새 active 질문 버전에 연결되어야 한다. 답변이 저장된 active 질문은 더 이상 재생성할 수 없어야 하며, 슬롯당 재생성은 최대 2회여야 한다.

---

# 64. Acceptance Test C — 중단 및 복구

```text
질문 3개 생성
↓
Q1 답변
↓
브라우저 종료
↓
재로그인
```

이후:

> 작성 중인 성찰이 있어요. 이어서 진행할까요?

가 표시되어야 한다.

이어가기 선택 시:

- 이미지
- 질문
- Q1 답변
- 진행 상태

가 복구되어야 한다.

---

# 65. Acceptance Test D — 모든 질문 건너뛰기

```text
Q1 skip
Q2 skip
Q3 skip
```

인 경우:

`디자인 성찰 요약 보기`를 완료할 수 없어야 한다.

안내:

> 성찰 요약을 만들려면 최소 한 개의 질문에 답변해주세요.

---

# 66. Acceptance Test E — 완료와 다이어리 분리

```text
성찰 요약 확인
↓
Session Completed
↓
다이어리 작성하지 않고 종료
```

관리자에서는:

```text
도구 사용 1
다이어리 0
```

으로 표시되어야 한다.

다음 로그인에서 미작성 다이어리를 확인할 수 있도록 안내하는 것은 가능하다.

단, 이미 완료된 session 자체를 미완료로 되돌리지 않는다.

---

# 67. 권장 개발 순서

## STEP 1
프로젝트 생성 및 GitHub 연결

## STEP 2
Supabase 연결

## STEP 3
Auth / Participant / Admin Role

## STEP 4
DB Schema

## STEP 5
RLS

## STEP 6
Participant 기본 Layout

## STEP 7
Admin 기본 Layout

## STEP 8
Session 생성

## STEP 9
이미지 Upload / Storage

## STEP 10
작업 정보 입력 Form

## STEP 11
OpenAI 질문 생성 API

## STEP 12
Structured Output 저장

## STEP 13
이미지 + Pin UI

## STEP 14
질문 탐색

## STEP 15
답변 + Autosave

## STEP 16
건너뛰기

## STEP 17
질문 재생성

## STEP 18
표현 정리하기

## STEP 19
후속 질문

## STEP 20
완료 조건

## STEP 21
디자인 성찰 요약본

## STEP 22
사용 다이어리

## STEP 23
Participant History

## STEP 24
Admin Dashboard

## STEP 25
CSV Export

## STEP 26
Compact View

## STEP 27
전체 연구 시나리오 QA

---

# 68. 개발 시 중요 원칙

AI 기능부터 먼저 구현하지 않는다.

먼저 다음 관계를 안정적으로 만든다.

```text
Participant
↓
Session
↓
Image
↓
Question
↓
Question Version
↓
Answer
↓
Follow-up
↓
Summary
↓
Diary
```

그 다음 AI를 연결한다.

연구 중 가장 큰 문제는 UI가 조금 부족한 것이 아니라:

> 질문이나 답변 이력이 사라지는 것

이다.

따라서 데이터 구조와 Version History를 UI보다 먼저 안정화한다.

---

# 69. v1.0 Locked Decisions

아래 항목은 WHY BOX v1.0에서 확정된 사항이다.

### 서비스

- 웹 기반 도구
- 연구자 발급 계정
- Participant / Admin 분리
- Participant 홈에는 도구 사용/다이어리의 연구 진행 상태와 작성 중 세션 이어하기만 간단히 표시하며 Admin용 세부 연구 데이터는 노출하지 않음
- 최초 Admin 계정 1개는 Supabase Dashboard에서 생성하며 연구자는 해당 Admin 계정으로 로그인
- Participant 계정은 Admin 화면에서 생성; 참여자는 회원가입하지 않고 발급받은 로그인 정보를 사용
- Participant 로그인 ID는 `participant_code`; Participant 화면에는 이메일 주소를 요구하거나 노출하지 않음
- Supabase Auth가 이메일 식별자를 요구하는 경우 비라우팅 내부 Auth 주소로 서버 측에서 매핑
- 임시 비밀번호를 연구자가 직접 전달; 첫 로그인 강제 변경 없음; Admin은 임시 비밀번호 재설정 가능
- 최초 Admin 계정은 1개 생성하며 연구자는 해당 계정으로 로그인
- Participant는 회원가입하지 않으며 Admin이 생성한 계정/로그인 정보를 받아 로그인

### 이미지

- JPG/JPEG
- PNG
- 최대 10장
- 이미지당 10MB
- PDF 제외
- Drag & Drop
- File Picker
- Clipboard Paste

### 입력

- 디자인 분야 1차 + 2차
- 현재 작업 단계 5개 중 단일 선택
- 점검하고 싶은 부분 최대 3개
- 추가 설명 선택 입력
- 질문 수 기본 3개
- 질문 수 최소 1개
- 질문 수 최대 5개

### 질문

- 질문 생성 프레임워크 적용
- AI가 질문 target 자동 지정
- `region`
- `image`
- `multi_image`

### 응답

- 자유 서술
- Autosave
- 원문 보존

### 표현 정리

- 선택 기능
- 의미 변경 금지
- 새로운 조언 추가 금지
- 원문 보존

### 후속 질문

- 선택 기능
- 최초 질문당 최대 2개

### 건너뛰기

- 가능
- 선택적 사유 기록

### 질문 재생성

- 최초 질문 슬롯당 최대 2회
- 이전 질문 삭제 금지
- 전체 Version Chain 보존
- 최초 질문의 `root_question_id`는 자기 ID, `parent_question_id`는 null, `question_kind = original`, `regeneration_index = 0`
- 재생성 질문의 root는 슬롯 최초 질문 ID, parent는 바로 이전 버전 ID, regeneration index는 이전 버전보다 1 증가
- 후속 질문의 root는 해당 최초 질문 ID, parent는 후속 질문을 유발한 직전 질문 ID, `followup_index`는 1 또는 2
- 슬롯마다 active version은 하나이며, 재생성 뒤 작성한 답변은 active version의 `question_id`에 연결
- 이미 답변된 active 질문은 재생성 불가
- 후속 질문은 최초 질문 root당 최대 2개

### 세션 완료

- 모든 최초 질문 슬롯의 현재 active version 처리 필요
- 답변 또는 건너뛰기
- 최소 1개의 answered active version 필요
- `디자인 성찰 요약 보기`까지 진행
- `summary_ready`는 각 최초 질문 슬롯의 active version이 모두 answered/skipped이고, answered인 active version이 최소 1개일 때 진입
- 요약 생성 실패 시 `summary_ready` 유지 및 재시도 가능
- 요약 생성 및 저장 성공 시에만 `completed`로 변경하고 도구 사용 1회 완료

### 성찰 요약

- 사용자 응답만 재구성
- 새로운 AI 평가 금지
- 새로운 AI 조언 금지
- 새로운 AI 해결책 금지

### 다이어리

- 모든 사용 회차에 동일 문항 적용(5회 초과 포함)
- 3문항
- Q1 복수 선택 필수
- Q2 복수 선택 필수
- Q3 자유 서술 선택
- 세션 완료와 별도 상태로 저장
- 각 `session_id`에 연결하고 세션별 다이어리는 최대 1개

### 연구 회차 및 Participant 홈

- 연구 회차는 사용자가 선택하지 않으며 Participant별 completed session의 완료 순서로 계산
- 최소 연구 참여 기준은 5회이며, 5회 초과 추가 사용을 허용
- 모든 회차에 동일한 다이어리 적용
- Participant와 Admin은 누적 횟수를 `도구 사용 7회`, `다이어리 작성 7회`처럼 표시하며 `7/6`처럼 상한으로 오해할 형식은 사용하지 않음
- Admin은 전체 횟수와 별도로 최소 5회 기준 충족 여부를 표시할 수 있음
- Participant 홈은 진행 상태만 간단히 표시하고 Admin용 세부 데이터는 숨김

### 오류 안내 및 로그

- Participant에게 이해하기 쉬운 오류 메시지, 유형 코드, 기본 대응 방법 표시
- `AUTH`, `UPLOAD`, `AI`, `SAVE`, `NETWORK`, `UNKNOWN` 유형을 구분
- API 응답 전문, stack trace, API key 등 내부/보안 정보는 Participant 화면에 노출하지 않음
- `error_logs` DB 테이블에 `error_code`, `error_type`, `participant_id`, `session_id`, 선택적 `related_question_id`, `internal_error_message`, `retryable`, `occurred_at`을 저장
- 세부 오류 코드별 안내 문구와 재시도 가능 여부는 구현 시 error catalog에 연결
- 외부 오류 로그 서비스는 v1.0에서 사용하지 않음
- Participant용 오류 안내와 내부 오류 로그는 분리
- 기존 연구 데이터 보존 및 재시도 UI 제공

### 연구 회차

- Participant별 completed session을 `completed_at` 오름차순, 동률이면 `session.id` 오름차순으로 정렬하여 회차 계산
- 회차 번호는 DB에 별도 저장하지 않음
- Participant/Admin에는 `도구 사용 N회`, `다이어리 작성 N회` 형식으로 누적 횟수 표시
- 5회는 최소 연구 참여 기준이며 최대 사용 횟수가 아님; 5회 초과 및 동일 다이어리 사용 허용
- Admin은 전체 누적 횟수와 별도로 5회 충족 여부를 확인 가능

### 디자인 입력 선택지 관리

- 디자인 분야, 작업 단계, 점검 맥락은 별도 DB lookup table 없이 애플리케이션 stable ID 상수로 관리
- `WHY_BOX_SPEC.md`에 정의된 v1.0 목록과 ID를 사용

### 기록

- 자동 저장
- 미완료 세션 이어하기
- 완료 세션 Read Only
- 연구 로그 저장
- AI 생성 Metadata 저장
- CSV Export

### AI 기록

- model_id
- prompt_version
- framework_version
- 생성 시간
- 질문 원리
- 질문 세부 유형
- Target
- 선택 맥락
- 짧은 생성 근거

### 저장하지 않는 것

- AI 내부 Chain-of-Thought

### UI Style Foundation

- Light Mode only
- 밝고 차분한 연구/디자인 작업 도구의 인상을 유지하고 SaaS Dashboard처럼 과도하게 장식하지 않는다.
- White/Light Gray surface를 중심으로 border와 여백으로 영역을 구분하고 shadow는 최소화한다.
- Orange는 CTA, 선택 상태, Question Pin 및 핵심 상호작용에 제한적으로 사용한다.
- 질문과 사용자 디자인 이미지가 화면의 중심이며 장식적인 그래픽은 절제한다.
- 반복 사용 피로를 줄이고 한글 가독성을 우선한다.
- 선택 상태는 색상뿐 아니라 border, 크기, icon 등의 시각 신호도 함께 사용한다.
- Hover, Focus, Disabled, Error 상태를 구분한다.
- Desktop 작업 환경을 우선하되 360–440px Compact View를 위해 고정 px 레이아웃을 피한다.
- Phase 1은 재사용 가능한 Design Token, global style, 기본 component style 기반만 설정한다. 질문 화면과 Pin UI를 완성하지 않는다.

#### Color Tokens

| Token | Value |
|---|---|
| `primary` | `#FD8A5E` |
| `primary-hover` | `#F15A24` |
| `primary-light` | `#FFF1EB` |
| `background` | `#F8F8F7` |
| `surface` | `#FFFFFF` |
| `text-primary` | `#222222` |
| `text-secondary` | `#6B6B6B` |
| `text-muted` | `#999999` |
| `border` | `#E8E8E6` |
| `error` | `#D92D20` |

Success, warning, disabled는 이 palette와 조화되는 최소 색상 토큰으로 정의한다.

#### Typography

Pretendard를 우선 사용한다. local font asset이 준비되기 전에는 Pretendard를 font stack 첫 순위에 선언하고 시스템 sans-serif로 fallback한다.

| Style | Size / Weight / Line Height |
|---|---|
| Page Title | `28px / 700` |
| Section Title | `20px / 700` |
| Question | `18px / 600 / 1.6` |
| Card Title | `16px / 600` |
| Body | `15px / 400` |
| Button | `14px / 600` |
| Caption | `13px / 400` |

#### Shape, Spacing and Controls

- 기본 component radius `10–12px`, card radius `16px`
- Button/Input 기본 높이 `44px`; 충분한 높이의 textarea 제공
- 4px 기반 spacing: `4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48px`
- pill 형태는 chip/tag 등 필요한 요소에만 적용
- Question Pin은 Primary Orange와 번호를 사용한다. 선택된 Pin은 미선택 Pin과 색 이외에 border/size/icon 등의 차이를 둔다.

### UI Style Foundation

- Light Mode only
- 밝고 차분한 연구/디자인 작업 도구의 인상을 유지하고 SaaS Dashboard처럼 과도하게 장식하지 않는다.
- White/Light Gray surface를 중심으로 border와 여백으로 영역을 구분하고 shadow는 최소화한다.
- Orange는 CTA, 선택 상태, Question Pin 및 핵심 상호작용에 제한적으로 사용한다.
- 질문과 사용자 디자인 이미지가 화면의 중심이며 장식적인 그래픽은 절제한다.
- 반복 사용 피로를 줄이고 한글 가독성을 우선한다.
- 선택 상태는 색상뿐 아니라 border, 크기, icon 등의 시각 신호도 함께 사용한다.
- Hover, Focus, Disabled, Error 상태를 구분한다.
- Desktop 작업 환경을 우선하되 360–440px Compact View를 위해 고정 px 레이아웃을 피한다.
- Phase 1은 재사용 가능한 Design Token, global style, 기본 component style 기반만 설정한다. 질문 화면과 Pin UI를 완성하지 않는다.

#### Color Tokens

| Token | Value |
|---|---|
| `primary` | `#FD8A5E` |
| `primary-hover` | `#F15A24` |
| `primary-light` | `#FFF1EB` |
| `background` | `#F8F8F7` |
| `surface` | `#FFFFFF` |
| `text-primary` | `#222222` |
| `text-secondary` | `#6B6B6B` |
| `text-muted` | `#999999` |
| `border` | `#E8E8E6` |
| `error` | `#D92D20` |

Success, warning, disabled는 이 palette와 조화되는 최소 색상 토큰으로 정의한다.

#### Typography

Pretendard를 우선 사용한다. local font asset이 준비되기 전에는 Pretendard를 font stack 첫 순위에 선언하고 시스템 sans-serif로 fallback한다.

| Style | Size / Weight / Line Height |
|---|---|
| Page Title | `28px / 700` |
| Section Title | `20px / 700` |
| Question | `18px / 600 / 1.6` |
| Card Title | `16px / 600` |
| Body | `15px / 400` |
| Button | `14px / 600` |
| Caption | `13px / 400` |

#### Shape, Spacing and Controls

- 기본 component radius `10–12px`, card radius `16px`
- Button/Input 기본 높이 `44px`; 충분한 높이의 textarea 제공
- 4px 기반 spacing: `4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48px`
- pill 형태는 chip/tag 등 필요한 요소에만 적용
- Question Pin은 Primary Orange와 번호를 사용한다. 선택된 Pin은 미선택 Pin과 색 이외에 border/size/icon 등의 차이를 둔다.

---

# 70. Copilot 구현 지침

이 문서를 WHY BOX v1.0의 **Source of Truth**로 사용한다.

Copilot은 다음 규칙을 따른다.

1. `v1.0 Locked Decisions`를 임의로 변경하지 않는다.
2. 구현 편의를 이유로 연구 로그를 삭제하거나 축소하지 않는다.
3. 기존 질문이나 응답을 overwrite하는 방식보다 Version History 보존을 우선한다.
4. 새로운 기능을 임의로 추가하지 않는다.
5. 명세에서 결정되지 않은 사항은 합리적인 기본값을 임의 구현하기보다 TODO 또는 확인 필요 사항으로 표시한다.
6. UI Polish보다 P0 기능을 먼저 완성한다.
7. Participant와 Admin의 데이터 접근 권한을 명확하게 분리한다.
8. AI 질문 생성은 디자인 평가 기능으로 변경하지 않는다.
9. AI 성찰 요약은 조언 기능으로 변경하지 않는다.
10. 실제 연구 시작 전 model / prompt / framework version을 고정한다.
11. 각 개발 단계가 끝날 때 기존 기능이 깨지지 않았는지 확인한다.
12. 연구 데이터가 손실될 가능성이 있는 Schema 변경은 임의로 수행하지 않는다.

---

# 71. 개발 시작 시 Copilot에게 전달할 첫 요청

이 문서를 프로젝트 루트의:

```text
WHY_BOX_SPEC.md
```

로 사용한다.

Copilot에게 처음에는 전체 서비스를 한 번에 구현하도록 요청하지 않는다.

먼저 다음과 같이 요청한다.

> `WHY_BOX_SPEC.md`를 이 프로젝트의 개발 기준 문서로 읽어줘.  
> 아직 코드를 작성하지 말고, 먼저 명세를 기준으로 WHY BOX v1.0의 기능 구조를 분석해줘.
>
> 특히 다음을 정리해줘.
>
> 1. Participant / Admin 기준 페이지 구조
> 2. 필요한 DB Table과 관계
> 3. Session 상태 구조
> 4. Question / Regeneration / Follow-up의 데이터 관계
> 5. Supabase Auth 및 RLS 구조
> 6. OpenAI API가 필요한 기능
> 7. 구현 순서
>
> `v1.0 Locked Decisions`는 변경하지 말고, 명세에서 결정되지 않은 부분이 있다면 임의로 구현하지 말고 별도로 알려줘.
>
> 분석 결과를 먼저 보여준 뒤 내가 확인하면 개발을 시작해줘.

---

# END

WHY BOX v1.0  
Development Specification