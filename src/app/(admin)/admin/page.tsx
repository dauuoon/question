import Link from "next/link";
import { requireRole } from "@/lib/auth/role";
import { readAdminDashboard } from "@/lib/admin/dashboard";
import { adminPage, researchDateTime } from "@/lib/admin/research-data";
import { ResearchDownload } from "./research-download";
import { accountTypeFilter, accountTypeLabel } from "@/lib/accounts/type";
import { MINIMUM_COMPLETED_SESSIONS } from "@/lib/constants/research-options";

export default async function AdminDashboardPage({ searchParams }: {
  searchParams: Promise<{ page?: string; type?: string }>;
}) {
  const { supabase } = await requireRole("admin");
  const params = await searchParams;
  const data = await readAdminDashboard(supabase, adminPage(params.page), accountTypeFilter(params.type));
  return (
    <section className="content-stack">
      <div>
        <p className="eyebrow">Admin</p>
        <h1 className="page-title">대시보드</h1>
      </div>
      <h2 className="card-title">연구 진행 현황 · P 계정만</h2>
      <div className="admin-metrics">
        <article className="summary-card"><h3 className="card-title">연구 참여자</h3><p>{data.research.participants}</p></article>
        <article className="summary-card"><h3 className="card-title">P 계정 전체 세션</h3><p>{data.research.sessions}</p></article>
        <article className="summary-card"><h3 className="card-title">P 계정 완료 세션</h3><p>{data.research.completed}</p></article>
        <article className="summary-card"><h3 className="card-title">P 계정 제출 다이어리</h3><p>{data.research.diaries}</p></article>
      </div>
      <article className="summary-card content-stack">
        <h3 className="card-title">최소 {MINIMUM_COMPLETED_SESSIONS}회 사용 달성</h3>
        <p>{data.research.achieved} / {data.research.participants}명 · {data.research.achievementRate.toFixed(1)}%</p>
        <progress className="research-progress" max={100} value={data.research.achievementRate}
          aria-label={`완료 세션 ${MINIMUM_COMPLETED_SESSIONS}회 이상인 P 참여자 달성률`} />
        <p className="supporting-copy">completed 세션만 계산합니다. P 참여자가 없으면 달성률은 0%입니다.</p>
      </article>
      <div className="admin-downloads" aria-label="연구 데이터 다운로드">
        <ResearchDownload kind="sessions" label="P 연구 세션 Excel 다운로드" />
        <ResearchDownload kind="diaries" label="P 연구 다이어리 Excel 다운로드" />
      </div>
      <h2 className="card-title">최근 사용 세션</h2>
      <nav className="admin-pagination" aria-label="최근 세션 유형 필터">
        {(["P", "T", "all", "unclassified"] as const).map(type => <Link key={type}
          href={`/admin?type=${type}`} aria-current={data.filter === type ? "page" : undefined}>
          {type === "all" ? "전체" : type === "unclassified" ? "미분류" : type}
        </Link>)}
      </nav>
      <p className="supporting-copy">세션·질문·답변·다이어리·브리핑 수정 기록의 최신 저장 시각 기준 · Asia/Seoul (UTC+09:00)</p>
      <ol className="reflection-records">
        {data.rows.map(session => <li key={session.id} className="reflection-record">
          <div>
            <p className="record-title">{session.participant_code} · {accountTypeLabel(session.account_type)} · {session.status}</p>
            <p className="record-meta">생성 {researchDateTime(session.created_at)} · 최근 활동 {researchDateTime(session.last_activity_at)}</p>
            <p className="record-meta">질문 {session.questions}/{session.requested_question_count} · 답변 {session.answered} · 건너뛰기 {session.skipped}</p>
          </div>
          <Link className="text-link" href={`/admin/sessions/${session.id}`}>상세 보기</Link>
        </li>)}
      </ol>
      {!data.rows.length ? <p role="status">선택한 유형의 사용 세션이 없습니다.</p> : null}
      <nav className="admin-pagination" aria-label="최근 세션 페이지">
        {data.page > 1 ? <Link href={`/admin?type=${data.filter}&page=${data.page - 1}`}>이전</Link> : null}
        <span>{data.page} / {data.pages}</span>
        {data.page < data.pages ? <Link href={`/admin?type=${data.filter}&page=${data.page + 1}`}>다음</Link> : null}
      </nav>
      <section className="service-usage content-stack" aria-label="전체 서비스 사용량">
        <h2 className="card-title">전체 서비스 사용량 · 운영 참고</h2>
        <p className="supporting-copy">완료 여부와 무관한 생성 세션 수입니다. 실제 API 호출 횟수나 비용이 아닙니다.</p>
        <div className="admin-metrics">
          <article className="summary-card"><h3>전체 세션 (P+T)</h3><p>{data.service.sessions}</p></article>
          <article className="summary-card"><h3>P 세션</h3><p>{data.service.p}</p></article>
          <article className="summary-card"><h3>T 세션</h3><p>{data.service.t}</p></article>
          {data.service.unclassified ? <article className="summary-card"><h3>미분류 세션 (별도)</h3><p>{data.service.unclassified}</p></article> : null}
        </div>
      </section>
    </section>
  );
}
