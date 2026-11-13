"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { saveSessionContextSupplement } from "./context-actions";

export function ContextSupplementEditor({
  sessionId,
  initialText,
  initialRevision,
  editable,
  available,
  onSaved,
}: {
  sessionId: string;
  initialText: string;
  initialRevision: number;
  editable: boolean;
  available: boolean;
  onSaved?: (value: { revision: number; text: string }) => void;
}) {
  const [text, setText] = useState(initialText);
  const [savedText, setSavedText] = useState(initialText);
  const [revision, setRevision] = useState(initialRevision);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const dirty = text !== savedText;

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element?.showModal();
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || saving || !dirty) return;
    setSaving(true);
    setMessage("");
    const submittedText = text;
    try {
      const result = await saveSessionContextSupplement(sessionId, {
        context_text: submittedText,
        expected_revision: revision,
      });
      if (!result.success) {
        setMessage(result.message);
        return;
      }
      setRevision(result.revision);
      setSavedText(result.context_text);
      onSaved?.({ revision: result.revision, text: result.context_text });
      setMessage("디자인 설명을 답변과 별도로 저장했습니다. 이후 새로 생성하는 질문에 반영됩니다.");
    } catch {
      setMessage("디자인 설명을 저장하지 못했습니다. 입력 내용은 그대로 남아 있습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="question-design-description">
      <button type="button" className="button-secondary" aria-haspopup="dialog"
        aria-expanded={open} onClick={() => setOpen(true)}>
        디자인 설명 보완{dirty ? " · 작성 중" : ""}
      </button>
      <dialog ref={dialog} className="question-context-supplement"
        aria-labelledby="question-context-supplement-title"
        onCancel={event => { event.preventDefault(); setOpen(false); }}>
      <header className="question-context-supplement-header">
        <h2 id="question-context-supplement-title">디자인 설명 보완</h2>
        <button type="button" className="question-context-supplement-close"
          aria-label="디자인 설명 보완 닫기" onClick={() => setOpen(false)}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      {available ? <>
      <form onSubmit={submit}>
        <label htmlFor="question-context-supplement-text">추가하거나 수정할 디자인 설명</label>
        <textarea
          id="question-context-supplement-text"
          value={text}
          maxLength={1000}
          disabled={!editable || saving}
          onChange={event => setText(event.target.value)}
          placeholder="예: 이번 화면에서 특히 고려하고 있는 사용자나 피할 수 없는 제약이 있다면 적어주세요."
        />
        <div className="question-context-supplement-actions">
          <span>{text.length} / 1,000자{dirty ? " · 저장되지 않음" : ""}</span>
          <button type="submit" className="button-secondary" disabled={!editable || saving || !dirty}>
            {saving ? "저장 중…" : "설명 저장"}
          </button>
        </div>
        {message ? <p className="question-context-supplement-status" role="status">{message}</p> : null}
        {dirty ? <p className="question-context-supplement-status">닫아도 작성 중인 설명은 유지됩니다. 저장 전에는 질문 생성에 반영되지 않습니다.</p> : null}
      </form>
      </> : <p className="question-context-supplement-status" role="status">
        디자인 설명 보완 기능이 이 환경에 아직 적용되지 않았습니다. 기존 질문과 답변은 계속 이용할 수 있습니다.
      </p>}
      </dialog>
    </div>
  );
}
