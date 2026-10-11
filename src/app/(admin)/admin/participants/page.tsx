import { requireRole } from "@/lib/auth/role";
import { CreateParticipantForm, ManageParticipantForm, ChangeAccountTypeForm } from "./account-forms";
import { formatResearchDate } from "@/lib/activity/screen";
import Link from "next/link";
import { MINIMUM_COMPLETED_SESSIONS } from "@/lib/constants/research-options";
import { accountTypeLabel, accountTypeFilter } from "@/lib/accounts/type";
import { readAdminParticipants } from "@/lib/admin/participants";
import { adminPage } from "@/lib/admin/research-data";

export default async function AdminParticipantsPage({ searchParams }: {
  searchParams?: Promise<{ type?: string; page?: string }>;
} = {}) {
  const params = await searchParams;
  const filter = accountTypeFilter(params?.type ?? "all");
  const { supabase } = await requireRole("admin");
  const { rows: participants, page, pages } = await readAdminParticipants(supabase, adminPage(params?.page), filter);
  return (
    <section className="content-stack">
      <div>
        <p className="eyebrow">Admin</p>
        <h1 className="page-title">계정관리</h1>
      </div>
      <nav className="admin-pagination" aria-label="계정 유형 필터">
        {(["all", "P", "T", "unclassified"] as const).map(type => <Link key={type}
          aria-current={filter === type ? "page" : undefined} href={`/admin/participants?type=${type}`}>
          {type === "all" ? "전체" : type === "unclassified" ? "미분류" : type}
        </Link>)}
      </nav>
      <div className="account-management-layout">
        <CreateParticipantForm />
        <div className="participant-grid">
        {participants.map((participant) => (
          <article key={participant.id} className="summary-card">
            <h2 className="card-title">{participant.participant_code}</h2>
            <p>{accountTypeLabel(participant.account_type)}</p>
            <p>{participant.status === "active" ? "활성" : "비활성"}</p>
            <div className="account-dates">
              <span>생성일 {formatResearchDate(participant.created_at)}</span>
              <span>최근 사용일 {formatResearchDate(participant.last_activity_at)}</span>
            </div>
            <p>도구 사용 {participant.completed}회 · 다이어리 작성 {participant.diaries}회</p>
            <p>{participant.account_type === "P" ?
              `최소 ${MINIMUM_COMPLETED_SESSIONS}회 사용 ${participant.completed >= MINIMUM_COMPLETED_SESSIONS ? "충족" : "미충족"}` :
              "연구 달성률 집계 제외"}</p>
            <Link className="text-link" href={`/admin/participants/${participant.id}`}>세션 기록 보기</Link>
            <ManageParticipantForm id={participant.id} active={participant.status === "active"} />
            <ChangeAccountTypeForm id={participant.id} accountType={participant.account_type} />
          </article>
        ))}
          {participants.length === 0 ? <p>등록된 참여자가 없습니다.</p> : null}
        </div>
      </div>
      <nav className="admin-pagination" aria-label="계정 페이지">
        {page > 1 ? <Link href={`/admin/participants?type=${filter}&page=${page - 1}`}>이전</Link> : null}
        <span>{page} / {pages}</span>
        {page < pages ? <Link href={`/admin/participants?type=${filter}&page=${page + 1}`}>다음</Link> : null}
      </nav>
    </section>
  );
}
