"use client";

import { useEffect, useState } from "react";
import {
  diaryExperienceChoices,
  diaryFeelingChoices,
  diaryDraftSchema,
  diarySubmissionSchema,
} from "@/lib/diaries/contract";

type DiaryDraft = {
  experience_choices: string[];
  feeling_choices: string[];
  free_text: string;
};
type DiaryRecord = DiaryDraft & { status: "not_started" | "submitted"; submitted_at: string | null };

const emptyDraft: DiaryDraft = { experience_choices: [], feeling_choices: [], free_text: "" };
const draftKey = (sessionId: string) => `why-box:diary-draft:${sessionId}`;

export function DiaryPanel({ sessionId, active }: { sessionId: string; active: boolean }) {
  const [diary, setDiary] = useState<DiaryRecord | null>(null);
  const [draft, setDraft] = useState<DiaryDraft>(emptyDraft);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let canRestoreDraft = true;
      try {
        const response = await fetch(`/api/sessions/${sessionId}/diary`, { cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error("다이어리 상태를 불러오지 못했어요.");
        if (cancelled) return;
        canRestoreDraft = body.diary?.status !== "submitted";
        if (body.diary) {
          const parsed = diarySubmissionSchema.safeParse({
            experience_choices: body.diary.experience_choices,
            feeling_choices: body.diary.feeling_choices,
            free_text: body.diary.free_text,
          });
          if (body.diary.status === "submitted" && !parsed.success) {
            throw new Error("저장된 다이어리의 형식이 올바르지 않아요.");
          }
          if (parsed.success) {
            const loaded = {
              experience_choices: parsed.data.experience_choices,
              feeling_choices: parsed.data.feeling_choices,
              free_text: parsed.data.free_text ?? "",
            };
            setDraft(loaded);
            setDiary({ ...loaded, status: body.diary.status, submitted_at: body.diary.submitted_at });
          }
        }
      } catch {
        if (!cancelled) setError("다이어리 상태를 불러오지 못했어요. 다시 시도해주세요.");
      } finally {
        if (!cancelled && canRestoreDraft) {
          try {
            const stored = window.localStorage.getItem(draftKey(sessionId));
            if (stored) {
              const parsed = diaryDraftSchema.safeParse(JSON.parse(stored));
              if (parsed.success) {
                setDraft({ ...emptyDraft, ...parsed.data });
                setMessage("이 기기에 보관된 임시 다이어리 내용을 복구했어요.");
              }
            }
          } catch {
            setError("이 기기에 보관된 임시 다이어리 내용을 읽지 못했어요.");
          }
        }
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    if (!active || loading || diary?.status === "submitted") return;
    const timer = window.setTimeout(() => {
      void fetch(`/api/sessions/${sessionId}/diary`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "claim_prompt" }), cache: "no-store",
      }).then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error("DIARY-DB");
        if (body.claimed) setOpen(true);
      }).catch(() => setError("다이어리 알림을 표시하지 못했어요. 직접 작성 버튼으로 열 수 있어요."));
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [active, diary?.status, loading, sessionId]);

  useEffect(() => {
    if (loading || diary?.status === "submitted") return;
    try {
      window.localStorage.setItem(draftKey(sessionId), JSON.stringify(draft));
    } catch {
      setMessage("임시 입력을 이 기기에 보관하지 못했어요. 제출 전 화면을 닫지 마세요.");
    }
  }, [diary?.status, draft, loading, sessionId]);

  function toggleChoice(key: "experience_choices" | "feeling_choices", choice: string, exclusive: string) {
    setDraft(previous => {
      const current = previous[key];
      const next = current.includes(choice)
        ? current.filter(item => item !== choice)
        : choice === exclusive ? [choice] : [...current.filter(item => item !== exclusive), choice];
      return { ...previous, [key]: next };
    });
  }

  async function submitDiary() {
    const parsed = diarySubmissionSchema.safeParse({
      ...draft,
      free_text: draft.free_text || null,
    });
    if (!parsed.success) {
      setError("Q1과 Q2에서 각각 하나 이상의 항목을 선택해주세요.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/sessions/${sessionId}/diary`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit", diary: parsed.data }), cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.errorCode === "DIARY-SUBMITTED"
          ? "이미 제출된 다이어리가 있어요. 최신 내용을 다시 불러와주세요."
          : "다이어리를 저장하지 못했어요. 입력 내용은 이 기기에 보관되어 있어요.");
        return;
      }
      const submitted = { ...draft, status: "submitted" as const, submitted_at: body.submitted_at };
      setDiary(submitted);
      setMessage("다이어리를 제출했어요.");
      window.localStorage.removeItem(draftKey(sessionId));
    } catch {
      setError("다이어리를 저장하지 못했어요. 입력 내용은 이 기기에 보관되어 있어요.");
    } finally {
      setSaving(false);
    }
  }

  return <section className="diary-panel" aria-label="유저 다이어리(연구용)">
    <div className="diary-panel-heading">
      <h3 className="card-title">유저 다이어리(연구용)</h3>
      <button type="button" className="button-secondary" disabled={loading}
        onClick={() => { setError(""); setOpen(true); }}>
        {diary?.status === "submitted" ? "다이어리 보기" : "다이어리 작성"}
      </button>
    </div>
    {message ? <p role="status">{message}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {open ? <div className="diary-modal-backdrop" role="presentation">
      <section className="diary-modal" role="dialog" aria-modal="true" aria-labelledby="diary-title" aria-describedby="diary-description">
        <div className="diary-modal-heading">
          <h2 id="diary-title">유저 다이어리(연구용)</h2>
          <p id="diary-description" className="diary-description">연구에 도움이 되는 소중한 기록이니, 사용 후 잠시만 시간을 내어 간단한 다이어리를 작성해 주시면 감사하겠습니다.</p>
        </div>
        {diary?.status === "submitted" ?
          <div className="diary-readonly">
            <fieldset><legend>Q1. 이번 질문을 통해 어떤 경험을 했나요?</legend>
              {diary.experience_choices.map(choice => <p key={choice}>{choice}</p>)}
            </fieldset>
            <fieldset><legend>Q2. 이번 사용에서 느낀 점을 선택해주세요.</legend>
              {diary.feeling_choices.map(choice => <p key={choice}>{choice}</p>)}
            </fieldset>
            <fieldset><legend>Q3. 이번 사용에서 기억에 남는 점이 있다면 자유롭게 남겨주세요.</legend>
              <p>{diary.free_text || "작성하지 않았어요."}</p>
            </fieldset>
            {diary.submitted_at ? <p>제출 완료 · {new Date(diary.submitted_at).toLocaleString("ko-KR")}</p> : null}
            <div className="diary-actions">
              <button type="button" className="button-secondary"
                onClick={() => setOpen(false)}>닫기</button>
            </div>
          </div> :
          <form onSubmit={event => { event.preventDefault(); void submitDiary(); }}>
            <fieldset disabled={saving}>
              <legend>Q1. 이번 질문을 통해 어떤 경험을 했나요? (복수선택) <span className="diary-required" aria-label="필수">*</span></legend>
              {diaryExperienceChoices.map(choice => <label className="diary-choice" key={choice}>
                <input type="checkbox" checked={draft.experience_choices.includes(choice)}
                  onChange={() => toggleChoice("experience_choices", choice, "특별한 변화는 없었다")} />
                {choice}
              </label>)}
            </fieldset>
            <fieldset disabled={saving}>
              <legend>Q2. 이번 사용에서 느낀 점을 선택해주세요. (복수선택) <span className="diary-required" aria-label="필수">*</span></legend>
              {diaryFeelingChoices.map(choice => <label className="diary-choice" key={choice}>
                <input type="checkbox" checked={draft.feeling_choices.includes(choice)}
                  onChange={() => toggleChoice("feeling_choices", choice, "특별한 느낌이 없었어요")} />
                {choice}
              </label>)}
            </fieldset>
            <label className="diary-free-text" htmlFor={`diary-free-text-${sessionId}`}>
              <span>Q3. 이번 사용에서 기억에 남는 점이 있다면 자유롭게 남겨주세요.</span>
              <textarea id={`diary-free-text-${sessionId}`} maxLength={20_000} value={draft.free_text}
                onChange={event => setDraft(previous => ({ ...previous, free_text: event.target.value }))} />
            </label>
            {error ? <p role="alert">{error}</p> : null}
            {message ? <p role="status">{message}</p> : null}
            <div className="diary-actions">
              <button type="button" className="button-secondary" disabled={saving}
                onClick={() => setOpen(false)}>닫기</button>
              <button type="submit" disabled={saving}>{saving ? "제출 중..." : "제출 하기"}</button>
            </div>
          </form>}
      </section>
    </div> : null}
  </section>;
}
