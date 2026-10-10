import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireRole } from "@/lib/auth/role";
import { formatResearchDate } from "@/lib/activity/screen";

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
    supabase.from("profiles").select("id,participant_code,status").eq("id", participantId)
      .eq("role", "participant").maybeSingle(),
    supabase.from("sessions")
      .select("id,status,created_at,completed_at,primary_category_id,subcategory_id,other_category_text")
      .eq("participant_id", participantId).order("created_at", { ascending: false }),
  ]);
  if (profileError || sessionsError) throw new Error("Unable to load participant session records.");
  if (!profile) notFound();

  return (
    <section className="content-stack">
      <div>
        <p className="eyebrow">Admin · Participant</p>
        <h1 className="page-title">{profile.participant_code} 세션 기록</h1>
      </div>
      <p className="supporting-copy">계정 상태: {profile.status === "active" ? "활성" : "비활성"}</p>
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
