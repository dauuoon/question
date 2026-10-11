import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireRole } from "@/lib/auth/role";
import { diaryExperienceChoices, diaryFeelingChoices } from "@/lib/diaries/contract";
import { ResearchDownload } from "../../research-download";
import { accountTypeLabel, accountTypeSchema } from "@/lib/accounts/type";

type AdminSessionPageProps = {
  params: Promise<{ sessionId: string }>;
};

export default async function AdminSessionPage({
  params,
}: AdminSessionPageProps) {
  const { sessionId } = await params;
  if (!z.uuid().safeParse(sessionId).success) notFound();
  const { supabase } = await requireRole("admin");
  const { data: session, error: sessionError } = await supabase.from("sessions")
    .select("id,participant_id,status,created_at,completed_at,primary_category_id,subcategory_id,other_category_text,stage_id,additional_context,summary_text")
    .eq("id", sessionId).maybeSingle();
  if (sessionError) throw new Error("Unable to load this session.");
  if (!session) notFound();
  const [profileResult, contextResult, questionResult, eventResult,
    sourceResult, versionResult, diaryResult, requestResult] = await Promise.all([
    supabase.from("profiles").select("participant_code,status,role,account_type").eq("id", session.participant_id).maybeSingle(),
    supabase.from("session_contexts").select("context_id").eq("session_id", sessionId).order("context_id"),
    supabase.from("questions")
      .select("id,slot_index,question_text,question_kind,status,is_active_version,root_question_id,parent_question_id,regeneration_index,followup_index,skip_reason,skipped_at,answered_at,model_id,prompt_version,framework_version,generated_at")
      .eq("session_id", sessionId).order("slot_index").order("created_at"),
    supabase.from("question_events")
      .select("question_id,event_type,event_data,created_at").eq("session_id", sessionId).order("created_at"),
    supabase.from("session_briefing_sources")
      .select("source_text,model_id,prompt_version,schema_version,generated_at").eq("session_id", sessionId).maybeSingle(),
    supabase.from("session_briefing_versions")
      .select("revision,briefing_text,edited_by,edited_at").eq("session_id", sessionId).order("revision"),
    supabase.from("diaries")
      .select("experience_choices_json,feeling_choices_json,free_text,status,submitted_at")
      .eq("session_id", sessionId).maybeSingle(),
    supabase.from("session_briefing_requests")
      .select("attempt_number,state,failure_code,created_at,finished_at").eq("session_id", sessionId).order("attempt_number"),
  ]);
  if ([profileResult, contextResult, questionResult, eventResult, sourceResult,
    versionResult, diaryResult, requestResult].some(result => result.error)) {
    throw new Error("Unable to load read-only session research details.");
  }
  const questionIds = (questionResult.data ?? []).map(question => question.id);
  const answerResult = questionIds.length ? await supabase.from("answers")
    .select("question_id,original_answer,refined_answer,refinement_used,current_answer_version,refined_at,updated_at")
    .in("question_id", questionIds) : { data: [], error: null };
  if (answerResult.error) throw new Error("Unable to load read-only session answers.");
  const answerByQuestion = new Map((answerResult.data ?? []).map(answer => [answer.question_id, answer]));
  const accountType = accountTypeSchema.nullable().parse(profileResult.data?.account_type);

  return (
    <section className="content-stack">
      {profileResult.data?.role === "participant" && accountType === "P" ?
        <ResearchDownload kind="session" id={sessionId} label="이 세션 연구 기록 Excel 다운로드" /> :
        <p className="supporting-copy">이 세션은 연구용 Excel에서 제외됩니다. 관리자 상세 조회는 가능합니다.</p>}
      <p>{accountTypeLabel(accountType)}</p>
      <div>
        <p className="eyebrow">Admin · Session</p>
        <h1 className="page-title">{profileResult.data?.participant_code ?? "참여자"} · 세션 상세</h1>
      </div>
      <Link className="text-link" href={`/admin/participants/${session.participant_id}`}>참여자 세션 목록</Link>
      <article className="summary-card content-stack">
        <h2 className="card-title">세션 정보</h2>
        <p>상태: {session.status} · 생성: {session.created_at} · 완료: {session.completed_at ?? "미완료"}</p>
        <p>디자인 맥락: {session.primary_category_id ?? "없음"} / {session.subcategory_id ?? "없음"}
          {session.other_category_text ? ` / ${session.other_category_text}` : ""}</p>
        <p>진행 단계: {session.stage_id ?? "없음"}</p>
        <p>추가 맥락: {session.additional_context || "없음"}</p>
        <p>선택 맥락: {(contextResult.data ?? []).map(item => item.context_id).join(", ") || "없음"}</p>
      </article>
      <section className="content-stack">
        <h2 className="card-title">질문과 답변</h2>
        {(questionResult.data ?? []).map(question => {
          const answer = answerByQuestion.get(question.id);
          return <article className="summary-card content-stack" key={question.id}>
            <h3>슬롯 {question.slot_index} · {question.question_kind}
              {!question.is_active_version ? " · 이전 버전" : ""}</h3>
            <p>{question.question_text}</p>
            <p>상태: {question.status}{question.status === "skipped" ? ` · 건너뛰기: ${question.skip_reason ?? "사유 없음"}` : ""}</p>
            <p>출처: {question.model_id} · prompt {question.prompt_version} · framework {question.framework_version}</p>
            {answer ? <>
              <p><strong>원문 답변</strong></p><p className="preserve-whitespace">{answer.original_answer || "답변 없음"}</p>
              {answer.refined_answer ? <>
                <p><strong>문장 다듬기 결과</strong> · 선택 버전: {answer.current_answer_version}
                  · 다듬기 사용: {answer.refinement_used ? "예" : "아니요"}
                  {answer.refined_at ? ` · ${answer.refined_at}` : ""}</p>
                <p className="preserve-whitespace">{answer.refined_answer}</p>
              </> : null}
            </> : <p>답변 없음</p>}
          </article>;
        })}
        {(eventResult.data ?? []).length ? <details>
          <summary>질문 처리 및 건너뛰기 이력</summary>
          <ol>{(eventResult.data ?? []).map((event, index) => <li key={`${event.created_at}-${index}`}>
            {event.event_type} · {event.created_at} · {event.question_id ?? "세션"}
            {event.event_data ? ` · ${JSON.stringify(event.event_data)}` : ""}
          </li>)}</ol>
        </details> : null}
      </section>
      <article className="summary-card content-stack">
        <h2 className="card-title">디자인 브리핑</h2>
        {sourceResult.data ? <>
          <h3>AI 생성 원본 · {sourceResult.data.model_id}</h3>
          <p className="preserve-whitespace">{sourceResult.data.source_text}</p>
          <p>Prompt {sourceResult.data.prompt_version} · Schema {sourceResult.data.schema_version} · {sourceResult.data.generated_at}</p>
        </> : <p>저장된 AI 브리핑 원본이 없습니다.</p>}
        {(versionResult.data ?? []).map(version => <section key={version.revision}>
          <h3>사용자 수정본 revision {version.revision}</h3>
          <p className="preserve-whitespace">{version.briefing_text}</p>
          <p>작성자 {version.edited_by} · {version.edited_at}</p>
        </section>)}
        {(requestResult.data ?? []).length ? <details>
          <summary>브리핑 생성 상태 및 실패 기록</summary>
          <ul>{(requestResult.data ?? []).map(request => <li key={request.attempt_number}>
            시도 {request.attempt_number} · {request.state}
            {request.failure_code ? ` · ${request.failure_code}` : ""} · {request.created_at}
          </li>)}</ul>
        </details> : null}
      </article>
      <article className="summary-card content-stack">
        <h2 className="card-title">사용 다이어리</h2>
        {diaryResult.data?.status === "submitted" ? <>
          <h3>Q1. 이번 질문을 통해 어떤 경험을 했나요?</h3>
          <ul>{(diaryResult.data.experience_choices_json as string[]).map(choice => <li key={choice}>
            {diaryExperienceChoices.includes(choice as typeof diaryExperienceChoices[number]) ? choice : "명세에 없는 선택 항목"}
          </li>)}</ul>
          <h3>Q2. 이번 사용에서 느낀 점을 선택해주세요.</h3>
          <ul>{(diaryResult.data.feeling_choices_json as string[]).map(choice => <li key={choice}>
            {diaryFeelingChoices.includes(choice as typeof diaryFeelingChoices[number]) ? choice : "명세에 없는 선택 항목"}
          </li>)}</ul>
          <h3>Q3. 이번 사용에서 기억에 남는 점이 있다면 자유롭게 남겨주세요.</h3>
          <p className="preserve-whitespace">{diaryResult.data.free_text || "작성 없음"}</p>
          <p>제출: {diaryResult.data.submitted_at}</p>
        </> : <p>다이어리가 제출되지 않았습니다.</p>}
      </article>
    </section>
  );
}
