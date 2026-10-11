import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireRole } from "@/lib/auth/role";
import { formatResearchDate } from "@/lib/activity/screen";
import { ResearchDownload } from "../../research-download";
import { accountTypeLabel, accountTypeSchema } from "@/lib/accounts/type";
import { ChangeAccountTypeForm } from "../account-forms";

type AdminParticipantPageProps = {
  params: Promise<{ participantId: string }>;
};

export default async function AdminParticipantPage({
  params,
}: AdminParticipantPageProps) {
  const { participantId } = await params;
  if (!z.uuid().safeParse(participantId).success) notFound();
  const { supabase } = await requireRole("admin");
  const [{ data: profile, error: profileError }, { data: sessions, error: sessionsError }] = await Promise.all([
    supabase.from("profiles").select("id,participant_code,status,account_type").eq("id", participantId)
      .eq("role", "participant").maybeSingle(),
    supabase.from("sessions")
      .select("id,status,created_at,completed_at,primary_category_id,subcategory_id,other_category_text")
      .eq("participant_id", participantId).order("created_at", { ascending: false }),
  ]);
  if (profileError || sessionsError) throw new Error("Unable to load participant session records.");
  if (!profile) notFound();
  const accountType = accountTypeSchema.nullable().parse(profile.account_type);
  const { data: history, error: historyError } = await supabase.from("account_type_events")
    .select("id,previous_type,account_type,reason,changed_at,changed_by")
    .eq("participant_id", participantId).order("changed_at", { ascending: false }).limit(50);
  if (historyError) throw new Error("Unable to load account classification history.");

  return (
    <section className="content-stack">
      <div>
        <p className="eyebrow">Admin · Participant</p>
        <h1 className="page-title">{profile.participant_code} 세션 기록</h1>
      </div>
      <p className="supporting-copy">계정 상태: {profile.status === "active" ? "활성" : "비활성"}</p>
      <p>{accountTypeLabel(accountType)}</p>
      {accountType === "P" ? <ResearchDownload kind="participant" id={participantId} label="이 참여자 연구 기록 Excel 다운로드" /> :
        <p className="supporting-copy">연구용 Excel에서 제외된 계정입니다. 관리자 화면의 기록 조회는 가능합니다.</p>}
      <ChangeAccountTypeForm id={participantId} accountType={accountType} />
      <details><summary>유형 변경 이력 (최근 50건)</summary>
        <ol>{(history ?? []).map(event => <li key={event.id}>
          {event.previous_type ?? "미분류"} → {event.account_type} · {formatResearchDate(event.changed_at)}
          {` · ${event.reason} · 변경자 ${event.changed_by ?? "DB 운영자 / 계정 생성"}`}
        </li>)}</ol>
        {!history?.length ? <p>유형 변경 이력이 없습니다.</p> : null}
      </details>
      <ol className="reflection-records">
        {(sessions ?? []).map(session => <li className="reflection-record" key={session.id}>
          <div>
            <p className="record-title">
              {session.primary_category_id ?? "디자인 분류 미선택"}
              {session.subcategory_id ? ` > ${session.other_category_text || session.subcategory_id}` : ""}
            </p>
            <p className="record-meta">
              {session.status === "completed" ? "완료" : session.status} · {formatResearchDate(session.created_at)}
              {session.completed_at ? ` · 완료 ${formatResearchDate(session.completed_at)}` : ""}
            </p>
          </div>
          <Link className="text-link" href={`/admin/sessions/${session.id}`}>상세 보기</Link>
        </li>)}
      </ol>
      {!sessions?.length ? <p className="supporting-copy">세션 기록이 없습니다.</p> : null}
    </section>
  );
}
