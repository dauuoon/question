"use client";

import { useEffect, useRef, useState } from "react";
import { DESIGN_CATEGORIES, REFLECTION_CONTEXTS, WORK_STAGES } from "@/lib/constants/research-options";
import { characterCount, MAX_CONTEXT_LENGTH, type SessionContextInput } from "@/lib/session-context/input";
import { ContextAutosave, type SaveState } from "@/lib/session-context/autosave";
import { saveSessionContext } from "./context-actions";
import type { SessionStep } from "@/lib/session-context/wizard";
import { ContextDraftController, type DraftViewState } from "@/lib/session-context/context-draft-controller";
import { draftFingerprint } from "@/lib/ai/context-draft-contract";
import { Toast } from "@/app/toast";
import { useRouter } from "next/navigation";
import { CategorySelect } from "@/app/category-select";

export function SessionContextForm({ sessionId, initial, initialSavedAt, editable, activeStep, imageCount = null, imageRevision = "", onValueChange, onSaveStateChange, onRetryReady, onDraftStateChange, hasUnsavedChanges, lockedMessage }: {
  sessionId: string; initial: SessionContextInput; editable: boolean;
  activeStep: SessionStep; onValueChange?: (value: SessionContextInput) => void;
  imageCount?: number | null; imageRevision?: string;
  initialSavedAt?: string; onSaveStateChange?: (state: SaveState) => void;
  onRetryReady?: (retry: (() => void) | null) => void;
  onDraftStateChange?: (state: DraftViewState) => void;
  hasUnsavedChanges?: () => boolean;
  lockedMessage?: string;
}) {
  const [value, setValue] = useState(initial);
  const [state, setState] = useState<SaveState>({ status: "저장됨", message: "", savedAt: initialSavedAt });
  useEffect(() => { onSaveStateChange?.(state); }, [state, onSaveStateChange]);
  useEffect(() => {
    onRetryReady?.(() => saver.current?.retry());
    return () => onRetryReady?.(null);
  }, [onRetryReady]);
  const [confirmation, setConfirmation] = useState<{ kind: "regenerate" } | { kind: "navigate"; href: string } | null>(null);
  const router = useRouter();
  const saver = useRef<ContextAutosave | null>(null);
  const latest = useRef(initial);
  const seed = useRef(initial);
  const seedSavedAt = useRef(initialSavedAt);
  const callbacks = useRef({ onSaveStateChange, onDraftStateChange, hasUnsavedChanges });
  callbacks.current = { onSaveStateChange, onDraftStateChange, hasUnsavedChanges };
  const [draftState, setDraftState] = useState<DraftViewState>({ status: "idle", message: "" });
  const draft = useRef<ContextDraftController | null>(null);
  const currentDraft = useRef({ input: initial, editable, imageCount, imageRevision });
  const applyDraft = useRef<(text: string) => void>(() => {});
  currentDraft.current = { input: value, editable, imageCount, imageRevision };
  applyDraft.current = (text) => change({ additional_context: text }, 1000);

  useEffect(() => {
    if (!draft.current) draft.current = new ContextDraftController(sessionId,
      () => ({ ...currentDraft.current, input: latest.current }),
      (text) => applyDraft.current(text), (state) => {
        setDraftState(state); callbacks.current.onDraftStateChange?.(state);
      });
    const controller = draft.current;
    controller.attach();
    return () => controller.detach();
  }, [sessionId]);

  useEffect(() => {
    draft.current?.automatic(activeStep === 3);
  }, [activeStep, editable, imageCount, imageRevision, value]);

  useEffect(() => {
    const controller = new ContextAutosave(seed.current, (input) => saveSessionContext(sessionId, input), (state) => {
      setState(state); callbacks.current.onSaveStateChange?.(state);
    }, seedSavedAt.current);
    saver.current = controller;
    const warn = (event: BeforeUnloadEvent) => {
      if (controller.dirty || callbacks.current.hasUnsavedChanges?.()) { event.preventDefault(); event.returnValue = ""; }
    };
    const guardNavigation = (event: MouseEvent) => {
      if (!(controller.dirty || callbacks.current.hasUnsavedChanges?.()) || !(event.target instanceof Element)) return;
      const link = event.target.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" ||
        link.hasAttribute("download") || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const destination = new URL(link.href, window.location.href);
      if (destination.pathname === window.location.pathname && destination.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      setConfirmation({ kind: "navigate", href: destination.href });
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardNavigation, true);
    return () => {
      controller.dispose();
      saver.current = null;
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", guardNavigation, true);
    };
  }, [sessionId]);

  function change(patch: Partial<SessionContextInput>, delay = 200) {
    if (!editable) return;
    const next = { ...latest.current, ...patch };
    if (draftFingerprint(latest.current, "") !== draftFingerprint(next, "")) draft.current?.inputsChanged();
    latest.current = next;
    setValue(next);
    saver.current?.change(next, delay);
    onValueChange?.(next);
  }

  const count = characterCount(value.additional_context ?? "");

  return (
    <section className="content-stack" aria-label="작업 정보 입력 및 저장 상태">
      {confirmation ? <Toast message={confirmation.kind === "regenerate" ?
        "기존 작업 맥락을 새 AI 초안으로 교체하시겠어요? 생성에 실패하면 기존 내용은 유지됩니다." :
        "아직 저장되지 않은 입력이 있습니다. 이동하면 해당 입력이 사라질 수 있습니다. 이동하시겠어요?"}
        error={false} onDismiss={() => setConfirmation(null)} action={<>
          <button type="button" className="button-secondary" onClick={() => setConfirmation(null)}>취소</button>
          <button type="button" onClick={() => {
            const decision = confirmation;
            setConfirmation(null);
            if (decision.kind === "regenerate") void draft.current?.generate("manual");
            else {
              const destination = new URL(decision.href, window.location.href);
              if (destination.origin === window.location.origin && destination.pathname !== "/") router.push(destination.pathname + destination.search + destination.hash);
              else window.location.assign(destination.href);
            }
          }}>확인</button>
        </>} /> : null}
      {!editable ? <p role="status" className="context-lock-notice">
        {lockedMessage ?? "질문 생성 이후 또는 완료된 세션의 입력 정보는 변경할 수 없습니다."}
      </p> : null}
      <div className="session-context work-info content-stack wizard-panel" hidden={activeStep !== 2}>
      <fieldset disabled={!editable} className="context-fields">
        <legend>디자인 분류</legend>
        <CategorySelect id="subcategory" value={value.subcategory_id ?? ""} disabled={!editable} onChange={(selected) => {
          const parent = DESIGN_CATEGORIES.find((item) => item.items.some((child) => child.id === selected));
          change({ primary_category_id: parent?.id ?? null, subcategory_id: selected || null,
            other_category_text: parent?.id === "others" ? latest.current.other_category_text : null });
        }} />
        {value.primary_category_id === "others" ? <>
          <label htmlFor="other-category">디자인 분류 직접 입력</label>
          <input id="other-category" value={value.other_category_text ?? ""}
            onChange={(event) => change({ other_category_text: event.target.value || null }, 1000)} />
        </> : null}
      </fieldset>
      <fieldset disabled={!editable} className="context-fields">
        <legend>디자인 작업 단계</legend>
        <div className="stage-tags">
          {WORK_STAGES.map((item) => <label className="stage-tag" key={item.id}>
            <input type="radio" name="work-stage" value={item.id} checked={value.stage_id === item.id}
              onChange={() => change({ stage_id: item.id })} />
            <span>{item.label}</span>
          </label>)}
        </div>
      </fieldset>
      <fieldset disabled={!editable} className="context-fields reflection-group">
        <legend>점검하고 싶은 부분 ({value.context_ids.length}/3)</legend>
        <div className="context-fields reflection-choices">
        {REFLECTION_CONTEXTS.map((item) => {
          const checked = value.context_ids.includes(item.id);
          return <label key={item.id} className="context-choice">
            <input type="checkbox" checked={checked} disabled={!editable || (!checked && value.context_ids.length >= 3)}
              onChange={(event) => {
                const selected = latest.current.context_ids;
                if (event.target.checked && (selected.includes(item.id) || selected.length >= 3)) return;
                change({ context_ids: event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id) });
              }} />
            <span>{item.label}</span>
          </label>;
        })}
        </div>
      </fieldset>
      </div>
      <div className="context-fields wizard-panel" hidden={activeStep !== 3}>
        <p id="context-help" className={`context-ai-help${draftState.status === "loading" ? " is-loading" : ""}`} role="status">
          <img className="ai-icon-light" src="/images/ai.png" width="24" height="24" alt="" />
          <img className="ai-icon-dark" src="/images/ai-dark.png" width="24" height="24" alt="" />
          <span>{draftState.message && (draftState.status === "loading" || draftState.status === "success") ?
            draftState.message :
            "AI가 입력된 정보를 바탕으로 작업 맥락을 작성했어요. 자유롭게 수정하거나 추가할 수 있습니다."}</span>
        </p>
        {draftState.message && (draftState.status === "error" || draftState.status === "discarded") ?
          <Toast message={draftState.message} error /> : null}
        <div className="context-textarea">
        <textarea id="additional-context" disabled={!editable} value={value.additional_context ?? ""}
          aria-label="작업 맥락"
          aria-describedby="context-help context-count"
          onChange={(event) => {
            draft.current?.userEdited();
            const text = Array.from(event.target.value).slice(0, MAX_CONTEXT_LENGTH).join("");
            change({ additional_context: text || null }, 1000);
          }} />
        <p id="context-count" className="context-character-count">{count.toLocaleString("ko-KR")} / 1,000자</p>
        </div>
        {editable ? <button type="button" className="button-secondary" hidden
          disabled={draftState.status === "loading"} onClick={() => {
            if (latest.current.additional_context) { setConfirmation({ kind: "regenerate" }); return; }
            void draft.current?.generate("manual");
          }}>AI로 다시 작성 ↻</button> : null}
      </div>
      {editable ? <div>
        {!onSaveStateChange ? <p role="status">{state.status}</p> : null}
        {state.message ? <Toast message={state.message} error /> : null}
        {!onSaveStateChange && state.status === "저장 실패" ? <button type="button" onClick={() => saver.current?.retry()}>저장 다시 시도</button> : null}
      </div> : null}
    </section>
  );
}
