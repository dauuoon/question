import { notFound } from "next/navigation";
import { QuestionResult } from "@/app/(participant)/sessions/[sessionId]/question-result";
import { generationViewSchema } from "@/lib/question-generation/view-contract";

export default function QuestionPreviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  const imageId = "60000000-0000-4000-8000-000000000001";
  const illustration = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="760" viewBox="0 0 1000 760">
    <rect width="1000" height="760" fill="#f3f1eb"/>
    <rect x="70" y="55" width="860" height="650" rx="24" fill="white"/>
    <g font-family="sans-serif" fill="#24332d">
      <text x="115" y="115" font-size="24" font-weight="bold">SLOW WEEKEND</text>
      <text x="115" y="220" font-size="44" font-weight="bold">나만의 속도로 쉬어가는 주말</text>
      <text x="115" y="270" font-size="22" fill="#69756d">가까운 곳에서 발견하는 작은 휴식을 만나보세요.</text>
      <rect x="115" y="310" width="210" height="60" rx="12" fill="#385e49"/>
      <text x="149" y="349" font-size="21" fill="white">주말 코스 둘러보기</text>
      <rect x="115" y="420" width="350" height="210" rx="16" fill="#dce8d9"/>
      <path d="M115 580L220 460L310 540L385 480L465 580V630H115Z" fill="#91ab8c"/>
      <text x="145" y="674" font-size="22">숲길에서 보내는 오후</text>
      <rect x="505" y="420" width="350" height="210" rx="16" fill="#ece0ce"/>
      <circle cx="680" cy="517" r="60" fill="#c6a37b"/>
      <text x="535" y="674" font-size="22">동네 카페에서의 여유</text>
    </g>
  </svg>`;
  const result = generationViewSchema.parse({
    session_id: "20000000-0000-4000-8000-000000000001",
    state: "completed",
    requested_question_count: 3,
    failed_request_id: null,
    answer_editable: true,
    followup_enabled: false,
    readability_improved: true,
    question_actions: { ready: false, reserve_count: 0, reserve_count_by_question: {} },
    images: [{
      id: imageId, sort_order: 0, width: 1000, height: 760,
      signed_url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(illustration)}`,
    }],
    questions: [
      {
        text: "제목에서 ‘나만의 속도’를 강조한 이유는 무엇인가요?",
        answer: "바쁜 일상에서 벗어나고 싶은 사용자가 부담 없이 쉬는 시간을 떠올리도록 하고 싶었습니다.",
        form:null,
        region: { x: 0.11, y: 0.22, width: 0.75, height: 0.09 },
      },
      {
        text: "이 화면을 실제로 사용할 환경에서 검토할 기준 세 가지는 무엇인가요?",
        answer: "",
        form:{kind:"numbered",title:"확인할 기준 세 가지",labels:["항목 1","항목 2","항목 3"]},
        region: { x: 0.115, y: 0.405, width: 0.21, height: 0.085 },
      },
      {
        text: "두 코스 카드를 비교할 때, 먼저 살펴보고 싶은 부분은 무엇인가요?",
        answer: "",
        form:{kind:"choice",title:"비교할 부분",labels:["카드의 이미지","제목","카드의 배경","직접 입력","짧은 설명"],
          max_selections:1,explanation_prompt:"선택한 부분에서 어떤 차이를 확인하고 싶나요?"},
        region: { x: 0.11, y: 0.55, width: 0.75, height: 0.34 },
      },
    ].map((item, index) => ({
      id: `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      slot_index: index + 1,
      question_text: item.text,
      answer_form:item.form,
      status: item.answer ? "answered" : "unprocessed",
      regeneration_index: 0,
      targets: [{ image_id: imageId, sort_order: 0, ...item.region }],
      answer: {
        original_answer: item.answer, refined_answer: null, refinement_used: false,
        current_answer_version: "original",
        updated_at: item.answer ? "2026-11-11T12:00:00.000Z" : null,
      },
      followup_question: null,
      last_followup_request: null,
    })),
  });

  return <div className="participant-shell" data-theme="light">
    <main className="page-container content-stack">
      <section className="card">
        <h1>질문 화면 미리보기</h1>
        <p>가상의 디자인과 질문을 사용합니다. 답변은 현재 화면의 메모리에만 유지하며, DB 저장과 AI 호출은 하지 않습니다. 새로고침하면 초기화됩니다.</p>
        <p>질문 1: 자유 입력 · 질문 2: 기준 세 가지 · 질문 3: 하나 선택 또는 직접 입력. 입력 후 번호·핀으로 이동해 답변이 유지되는지 확인해보세요.</p>
        <p>질문 번호나 이미지 핀을 선택해보세요. 이미지 상단의 버튼으로 디자인 설명 팝업을 확인할 수 있습니다.</p>
      </section>
      <QuestionResult result={result} sessionId={result.session_id} localPreview
        initialContextSupplement={{ revision: 1, text: "바쁜 직장인이 가까운 곳에서 짧게 쉬는 경험을 소개하는 화면입니다." }} />
    </main>
  </div>;
}
