export type DesignSubcategory = {
  id: string;
  label: string;
};

export type DesignCategory = {
  id: string;
  label: string;
  items: readonly DesignSubcategory[];
};

export const DESIGN_CATEGORIES = [
  {
    id: "ux_ui",
    label: "UX/UI",
    items: [
      { id: "web_design", label: "웹 디자인" },
      { id: "mobile_app_design", label: "모바일 앱 디자인" },
      { id: "digital_product_design", label: "프로덕트 디자인" },
      { id: "service_design", label: "서비스 디자인" },
      { id: "interaction_design", label: "인터랙션 디자인" },
      { id: "design_system", label: "디자인 시스템" },
      { id: "game_ui_ux_design", label: "게임 UI/UX 디자인" },
    ],
  },
  {
    id: "brand_graphic",
    label: "브랜드 · 그래픽",
    items: [
      { id: "brand_design", label: "브랜드 디자인(BI/CI)" },
      { id: "graphic_design", label: "그래픽 디자인" },
      { id: "poster_design", label: "포스터 디자인" },
      {
        id: "advertising_campaign_design",
        label: "광고·캠페인 디자인",
      },
      { id: "content_design", label: "콘텐츠 디자인" },
      { id: "information_design", label: "인포그래픽·정보 디자인" },
    ],
  },
  {
    id: "editorial_package",
    label: "편집 · 패키지",
    items: [
      { id: "editorial_print_design", label: "편집 디자인(인쇄물)" },
      { id: "package_design", label: "패키지 디자인" },
    ],
  },
  {
    id: "illustration_character",
    label: "일러스트레이션 · 캐릭터",
    items: [
      { id: "illustration", label: "일러스트레이션" },
      { id: "character_design", label: "캐릭터 디자인" },
      { id: "pattern_design", label: "패턴 디자인" },
      { id: "icon_pictogram_design", label: "아이콘·픽토그램 디자인" },
    ],
  },
  {
    id: "video_motion",
    label: "영상 · 모션",
    items: [
      { id: "video_thumbnail_design", label: "영상 섬네일 디자인" },
      { id: "video_graphic_design", label: "영상 그래픽 디자인" },
      { id: "motion_graphic_design", label: "모션 그래픽 디자인" },
    ],
  },
  {
    id: "product_spatial",
    label: "제품 · 공간",
    items: [
      { id: "industrial_product_design", label: "제품 디자인" },
      { id: "spatial_design", label: "공간 디자인" },
      { id: "exhibition_design", label: "전시 디자인" },
      {
        id: "signage_environmental_graphic_design",
        label: "사이니지·환경 그래픽 디자인",
      },
    ],
  },
  {
    id: "others",
    label: "기타",
    items: [{ id: "other", label: "기타" }],
  },
] as const satisfies readonly DesignCategory[];

export const WORK_STAGES = [
  {
    id: "research_problem_definition",
    label: "리서치·문제정의",
  },
  { id: "idea_concept", label: "아이디어·컨셉" },
  { id: "structure_design", label: "구조·설계" },
  { id: "visualization_specification", label: "시각화·구체화" },
  { id: "review_improvement", label: "검토·개선" },
] as const;

export const REFLECTION_CONTEXTS = [
  { id: "problem_and_goal", label: "문제와 목표를 다시 살펴보고 싶어요" },
  { id: "design_concept", label: "현재 디자인의 컨셉을 점검하고 싶어요" },
  { id: "user_perspective", label: "사용자의 관점에서 생각해보고 싶어요" },
  {
    id: "information_element_structure",
    label: "정보와 요소의 구조를 점검하고 싶어요",
  },
  { id: "visual_form", label: "시각적·형태적 표현을 살펴보고 싶어요" },
  {
    id: "other_perspectives",
    label: "다른 관점이나 가능성을 탐색하고 싶어요",
  },
  {
    id: "decision_reasoning",
    label: "내 판단의 이유와 근거를 점검하고 싶어요",
  },
  {
    id: "intent_alignment",
    label: "현재 결과가 의도에 맞는지 확인하고 싶어요",
  },
  {
    id: "next_steps",
    label: "다음 단계에서 무엇을 시도할지 생각해보고 싶어요",
  },
] as const;
export const MINIMUM_COMPLETED_SESSIONS = 5;
