"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Autosave, type SaveState } from "@/lib/session-context/autosave";
import type { SessionContextInput } from "@/lib/session-context/input";
import { SESSION_STEPS, validateSessionStep, sessionStepStorageKey, parseSavedSessionStep, type SessionStep } from "@/lib/session-context/wizard";
import { ImageUploader } from "./image-uploader";
import { SessionContextForm } from "./session-context-form";
import { Toast } from "@/app/toast";
import { saveQuestionCount } from "./context-actions";
import { GenerationController, recoveryMessage, type GenerationUI } from "@/lib/question-generation/controller";
import { questionCountSchema, type GenerationView } from "@/lib/question-generation/view-contract";
import { QuestionResult } from "./question-result";
import { questionSessionStatus } from "@/lib/session-completion/display-state";
import { QuestionGenerationLoading } from "./question-generation-loading";
import { sessionContextSchema } from "@/lib/session-context/input";

export function SessionWizard({ sessionId, initial, initialSavedAt, initialGeneration, sessionStatus }: {
  sessionId: string; initial: SessionContextInput;
  initialSavedAt?: string;
  initialGeneration: GenerationView;
  sessionStatus: string;
}) {
  const [step, setStep] = useState<SessionStep>(1);
  const [value, setValue] = useState(initial);
  const [imageCount, setImageCount] = useState<number | null>(null);
  const [imageRevision, setImageRevision] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const [noticeRevision, setNoticeRevision] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const [saveState, setSaveState] = useState<SaveState>({ status: "저장됨", message: "", savedAt: initialSavedAt });
  const retry = useRef<(() => void) | null>(null);
  const setRetry = useCallback((action: (() => void) | null) => { retry.current = action; }, []);
  const [stepReady, setStepReady] = useState(false);
  const [stepStorageError, setStepStorageError] = useState<string | null>(null);
  const [generation, setGeneration] = useState<GenerationUI>({ view: initialGeneration, message: "", checking: false });
  const [questionCount, setQuestionCount] = useState(initialGeneration.requested_question_count);
  const [countSave, setCountSave] = useState<SaveState>({ status: "저장됨", message: "" });
  const [imagesAvailable, setImagesAvailable] = useState(false);
  const [draftLoading, setDraftLoading] = useState(false);
  const countSaver = useRef<Autosave<number> | null>(null);
  const controller = useRef<GenerationController | null>(null);
  const inputsEditable = generation.view.state === "editable";
  const eligible = inputsEditable && imageCount !== null && imageCount > 0 && imagesAvailable &&
    validateSessionStep(2, value, imageCount) === null && sessionContextSchema.safeParse(value).success &&
    questionCountSchema.safeParse(questionCount).success && saveState.status === "저장됨" &&
    countSave.status === "저장됨" && !draftLoading;
  const ready = useRef(false);
  ready.current = eligible;
  const changeSaveState = useCallback((state: SaveState) => {
    if (state.status !== "저장됨") ready.current = false;
    setSaveState(state);
  }, []);
  const changeAvailability = useCallback((available: boolean) => {
    if (!available) ready.current = false;
    setImagesAvailable(available);
  }, []);
  const changeDraftState = useCallback((state: { status: string }) => {
    if (state.status === "loading") ready.current = false;
    setDraftLoading(state.status === "loading");
  }, []);
  const seedGeneration = useRef(initialGeneration);
  const seedSavedAt = useRef(initialSavedAt);
  const hasCountChanges = useCallback(() => countSaver.current?.dirty ?? false, []);

  useEffect(() => {
    const saver = new Autosave(seedGeneration.current.requested_question_count,
      (count) => saveQuestionCount(sessionId, count), (state) => {
        if (state.status !== "저장됨") ready.current = false;
        setCountSave(state);
      }, seedSavedAt.current, String);
    countSaver.current = saver;
    return () => {
      saver.dispose(); countSaver.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!controller.current) controller.current = new GenerationController(seedGeneration.current,
      () => ready.current, (state) => { ready.current = false; setGeneration(state); });
    const current = controller.current;
    current.attach();
    return () => current.detach();
  }, [sessionId]);

  useEffect(() => {
    try {
      setStep(parseSavedSessionStep(window.localStorage.getItem(sessionStepStorageKey(sessionId))));
    } catch {
      setStepStorageError("마지막 단계를 불러오지 못해 1단계로 열었습니다. 이 브라우저의 저장소 설정을 확인해주세요.");
    }
    setStepReady(true);
  }, [sessionId]);

  function move(destination: SessionStep) {
    if (generation.view.state !== "editable") return;
    if (destination > step) {
      const error = validateSessionStep(step, value, imageCount);
      if (error) { setValidation(error); setNoticeRevision((revision) => revision + 1); return; }
    }
    setValidation(null);
    setStep(destination);
    try {
      window.localStorage.setItem(sessionStepStorageKey(sessionId), String(destination));
      setStepStorageError(null);
    } catch {
      setStepStorageError("현재 단계를 이 브라우저에 저장하지 못했습니다. 다시 접속하면 마지막 단계가 복원되지 않을 수 있습니다.");
    }
    heading.current?.focus();
  }

  if (generation.view.state === "completed") {
    return <QuestionResult result={generation.view} sessionStatus={questionSessionStatus(sessionStatus)} />;
  }
  if (!stepReady) return <p role="status">마지막 작업 단계를 불러오고 있어요.</p>;

  return (
    <>
    <section className="content-stack session-wizard" aria-label="성찰 준비" hidden={generation.view.state === "running"}>
      <h1 id="wizard-step-title" ref={heading} tabIndex={-1} className="page-title">
        {step}단계 - {SESSION_STEPS[step - 1]}
      </h1>
      <nav aria-label="성찰 준비 단계">
        <div className="step-gauge" role="progressbar" aria-label="현재 성찰 준비 단계"
          aria-valuemin={0} aria-valuemax={SESSION_STEPS.length} aria-valuenow={step} aria-valuetext={`${step}단계 ${SESSION_STEPS[step - 1]}`}>
          <div className="step-gauge-fill" style={{ width: `${step / SESSION_STEPS.length * 100}%` }} />
        </div>
      </nav>
      {/* Keep both components mounted so navigation cannot cancel uploads or autosave. */}
      <div className="wizard-panel" hidden={step !== 1} aria-labelledby="wizard-step-title">
        <ImageUploader sessionId={sessionId} editable={inputsEditable} onImageCountChange={setImageCount}
          onImageRevisionChange={setImageRevision} onAvailabilityChange={changeAvailability} />
      </div>
      <SessionContextForm sessionId={sessionId} initial={initial} editable={inputsEditable}
        initialSavedAt={initialSavedAt} onSaveStateChange={changeSaveState} onRetryReady={setRetry}
        onDraftStateChange={changeDraftState}
        hasUnsavedChanges={hasCountChanges}
        activeStep={step} imageCount={imageCount} imageRevision={imageRevision} onValueChange={setValue} />
      {generation.view.state === "recovery" ? <section className="summary-card content-stack" role="status" aria-live="polite">
        <h2 className="card-title">질문 생성 상태 확인</h2>
        <p>{generation.message || recoveryMessage}</p>
        <button type="button" disabled={generation.checking} onClick={() => void controller.current?.check()}>
          {generation.checking ? "확인 중" : "상태 확인"}
        </button>
      </section> : generation.message ? <p role="alert">{generation.message}</p> : null}
      {step === 3 ? <fieldset className="question-count-control" disabled={!inputsEditable}>
        <legend>질문 개수</legend>
        <div className="stage-tags">
          {[1, 2, 3, 4, 5].map((count) => <label className="stage-tag" key={count}>
            <input type="radio" name="question-count" value={count} checked={questionCount === count}
              onChange={() => {
                if (!inputsEditable) return;
                ready.current = false; setQuestionCount(count); countSaver.current?.change(count, 0);
              }} />
            <span>{count}</span>
          </label>)}
        </div>
        <p role="status" aria-live="polite">{countSave.status === "저장됨" ? "" : `질문 개수 ${countSave.status}`}</p>
        {countSave.message ? <p role="alert">{countSave.message}</p> : null}
        {countSave.status === "저장 실패" ? <button type="button" className="button-secondary"
          onClick={() => countSaver.current?.retry()}>질문 개수 저장 다시 시도</button> : null}
      </fieldset> : null}
      <div className="wizard-footer">
        {stepStorageError ? <Toast message={stepStorageError} error /> : null}
        {validation ? <Toast key={noticeRevision} message={validation} error /> : null}
        <div className="wizard-footer-inner">
        <div className="wizard-footer-row">
        {inputsEditable ? <div className="wizard-save-status" role="status" aria-live="polite">
          <span>{saveState.status}</span>
          {saveState.status === "저장됨" && saveState.savedAt ? <time dateTime={saveState.savedAt}
            title="최근 저장 확인 시각 · 한국 시간">
            {" "}({new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
              hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(saveState.savedAt))})
          </time> : null}
          {saveState.status === "저장 실패" ? <button type="button" className="button-secondary"
            onClick={() => retry.current?.()}>저장 다시 시도</button> : null}
        </div> : <span />}
        <div className="wizard-actions">
          {step > 1 ? <button type="button" className="button-secondary" disabled={!inputsEditable}
            onClick={() => move(step === 3 ? 2 : 1)}>이전</button> :
            <Link href="/history" className="button-link button-secondary">나가기</Link>}
          {step < 3 ? <button type="button" disabled={!inputsEditable}
            onClick={() => move(step === 1 ? 2 : 3)}>다음</button> :
            <button type="button" disabled={!eligible} onClick={() => void controller.current?.start()}>질문 생성하기</button>}
        </div>
        </div>
        </div>
      </div>
    </section>
    {generation.view.state === "running" ? <QuestionGenerationLoading /> : null}
    </>
  );
}
