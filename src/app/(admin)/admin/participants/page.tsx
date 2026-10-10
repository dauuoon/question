import { requireRole } from "@/lib/auth/role";
import { CreateParticipantForm, ManageParticipantForm } from "./account-forms";
import { formatResearchDate } from "@/lib/activity/screen";
import Link from "next/link";
import { MINIMUM_COMPLETED_SESSIONS } from "@/lib/constants/research-options";

export default async function AdminParticipantsPage() {
  const { supabase } = await requireRole("admin");
  const { data: profiles, error } = await supabase.from("profiles")
    .select("id, participant_code, status, created_at, last_activity_at").eq("role", "participant")
    .order("participant_code");
  if (error) throw new Error("Unable to load participant accounts.");
  const participants = await Promise.all((profiles ?? []).map(async (profile) => {
    const [sessions, diaries] = await Promise.all([
      supabase.from("sessions").select("id", { count: "exact", head: true })
        .eq("participant_id", profile.id).eq("status", "completed"),
      supabase.from("diaries").select("id", { count: "exact", head: true })
        .eq("participant_id", profile.id).eq("status", "submitted"),
    ]);
    if (sessions.error || diaries.error) throw new Error("Unable to load participant research counts.");
    return { ...profile, completed: sessions.count ?? 0, diaries: diaries.count ?? 0 };
  }));
  return (
    <section className="content-stack">
      <div>
        <p className="eyebrow">Admin</p>
        <h1 className="page-title">계정관리</h1>
      </div>
      <div className="account-management-layout">
        <CreateParticipantForm />
        <div className="participant-grid">
        {participants.map((participant) => (
          <article key={participant.id} className="summary-card">
            <h2 className="card-title">{participant.participant_code}</h2>
            <p>{participant.status === "active" ? "활성" : "비활성"}</p>
            <div className="account-dates">
              <span>생성일 {formatResearchDate(participant.created_at)}</span>
              <span>최근 사용일 {formatResearchDate(participant.last_activity_at)}</span>
            </div>
            <p>도구 사용 {participant.completed}회 · 다이어리 작성 {participant.diaries}회</p>
            <p>최소 {MINIMUM_COMPLETED_SESSIONS}회 사용 {participant.completed >= MINIMUM_COMPLETED_SESSIONS ? "충족" : "미충족"}</p>
            <Link className="text-link" href={`/admin/participants/${participant.id}`}>세션 기록 보기</Link>
            <ManageParticipantForm id={participant.id} active={participant.status === "active"} />
          </article>
        ))}
          {participants.length === 0 ? <p>등록된 참여자가 없습니다.</p> : null}
        </div>
      </div>
    </section>
  );
}
