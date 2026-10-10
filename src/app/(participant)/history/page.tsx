import Link from "next/link";
import { ActivityMarker } from "../activity-marker";
import { requireRole } from "@/lib/auth/role";
import { CreateSessionForm } from "../sessions/new/create-session-form";
import { DESIGN_CATEGORIES } from "@/lib/constants/research-options";

type RecordSession = {
  id: string; status: string; created_at: string; updated_at: string;
  primary_category_id: string | null; subcategory_id: string | null;
  other_category_text: string | null;
};

export default async function ParticipantHistoryPage() {
  const { supabase, user } = await requireRole("participant");
  const [{ data: profile, error: profileError }, { count: diaryCount, error: diaryError }] = await Promise.all([
    supabase.from("profiles").select("participant_code").eq("id", user.id).single(),
    supabase.from("diaries").select("id", { count: "exact", head: true })
      .eq("participant_id", user.id).eq("status", "submitted"),
  ]);
  if (profileError || !profile?.participant_code) throw new Error("Unable to load the participant identifier.");
  if (diaryError) throw new Error("Unable to count submitted diaries.");

  const sessions: RecordSession[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from("sessions")
      .select("id, status, created_at, updated_at, primary_category_id, subcategory_id, other_category_text")
      .eq("participant_id", user.id).order("updated_at", { ascending: false })
      .order("id", { ascending: false }).range(offset, offset + 499);
    if (error || !data) throw new Error("Unable to load reflection records.");
    sessions.push(...data);
    if (data.length < 500) break;
  }
  const chronological = [...sessions].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const numbers = new Map(chronological.map((session, index) => [session.id, index + 1]));
  const date = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });

  return (
    <section className="content-stack participant-home">
      <ActivityMarker path="/history" participantId={user.id} />
      <div>
        <p className="eyebrow">Record · 나의기록</p>
        <h1 className="page-title">반가워요 :) {profile.participant_code} 디자이너님!</h1>
      </div>
      <div className="progress-row" aria-label="누적 사용 현황">
        <article className="summary-card">
          <h2 className="card-title">도구 사용</h2>
          <p className="count-value">{sessions.filter((session) => session.status === "completed").length}회</p>
        </article>
        <article className="summary-card">
          <h2 className="card-title">다이어리 작성</h2>
          <p className="count-value">{diaryCount ?? 0}회</p>
        </article>
      </div>
      <section className="content-stack" aria-labelledby="records-title">
        <h2 id="records-title" className="card-title">성찰 기록</h2>
        {sessions.length === 0 ? <p className="supporting-copy">아직 성찰 기록이 없습니다.</p> :
          <ol className="reflection-records">
            {sessions.map((session) => {
              const category = DESIGN_CATEGORIES.find((item) => item.id === session.primary_category_id);
              const secondary = category?.items.find((item) => item.id === session.subcategory_id);
              const completed = session.status === "completed";
              return <li key={session.id} className={`reflection-record ${completed ? "is-completed" : "is-progress"}`}>
                <div className="record-description">
                  <span className="record-number">{numbers.get(session.id)}</span>
                  <div>
                    <p className="record-title">
                      {category?.label ?? "디자인 분류 미선택"}{secondary ? ` > ${session.other_category_text || secondary.label}` : ""}
                    </p>
                    <p className="record-meta">
                      {completed ? "완료" : "진행 중"} · 최근 작업일 <time dateTime={session.updated_at}>{date.format(new Date(session.updated_at))}</time>
                    </p>
                  </div>
                </div>
                <Link className="text-link" href={`/sessions/${session.id}`}
                  aria-label={`${numbers.get(session.id)}번 성찰 ${completed ? "상세보기" : "이어하기"}`}>
                  {completed ? "상세보기" : "이어하기"}
                </Link>
              </li>;
            })}
          </ol>}
      </section>
      <div className="wizard-footer">
        <div className="wizard-footer-inner">
          <div className="wizard-footer-row">
            <span />
            <div className="wizard-actions home-start"><CreateSessionForm /></div>
          </div>
        </div>
      </div>
    </section>
  );
}
