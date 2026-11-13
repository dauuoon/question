"use client";

import { useImperativeHandle, useLayoutEffect, useRef, type Ref, type TextareaHTMLAttributes } from "react";
import { answerFieldsText, type AnswerForm } from "@/lib/answers/form";

function GrowingTextarea({ inputRef, value, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  inputRef?: Ref<HTMLTextAreaElement>;
  value: string;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(inputRef, () => textarea.current!, []);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const resize = () => {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [value]);
  return <textarea {...props} ref={textarea} value={value} rows={2} />;
}

export function AnswerFormInput({ form, fields, disabled, inputRef, onChange, id, choiceDraft, onChoiceDraft, legacyText }: {
  form: AnswerForm;
  fields: string[];
  disabled: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  onChange: (text: string, fields: string[]) => void;
  id: string;
  choiceDraft?: { text: string; selected: boolean };
  onChoiceDraft?: (draft: { text: string; selected: boolean }) => void;
  legacyText?: string;
}) {
  const latest = useRef(fields);
  latest.current = fields;
  const update = (index: number, value: string) => {
    const next = [...latest.current];
    next[index] = value;
    latest.current = next;
    onChange(answerFieldsText(next), next);
  };
  if (form.kind === "choice") {
    const options = form.labels.slice(0, -2);
    const otherIndex = form.labels.length - 2;
    const hasLegacyText = !!fields.at(-1)?.trim();
    const hasLegacyAnswer = hasLegacyText || fields.slice(0,-2).filter(Boolean).length > 1 ||
      (!!fields[otherIndex]?.trim() && fields.slice(0,-2).some(Boolean));
    const direct = choiceDraft?.selected ?? (!!fields[otherIndex]?.trim() &&
      !fields.slice(0, -2).some(Boolean) && !hasLegacyText);
    const draftText = choiceDraft?.text ?? (direct ? fields[otherIndex] : "");
    const updateChoice = (index: number, value: string) => {
      const next = form.labels.map(() => "");
      next[index] = value;
      latest.current = next;
      onChange(answerFieldsText(next), next);
    };
    return <fieldset className="question-answer-form question-choice-form" disabled={disabled}>
      <legend>[{form.title}] <span className="question-choice-limit">*1개 선택</span></legend>
      <div className="question-choice-options">
        {options.map((label, index) => <label className="question-choice-option" key={label}>
          <input type="checkbox" checked={fields[index] === label}
            onChange={event => {
              onChoiceDraft?.({text:draftText,selected:false});
              updateChoice(index, event.target.checked ? label : "");
            }} />
          <span className="question-choice-chip"><span className="question-choice-check" aria-hidden="true">✓</span>{label}</span>
        </label>)}
        <label className="question-choice-option">
          <input type="checkbox" checked={direct} onChange={event => {
            onChoiceDraft?.({text:draftText,selected:event.target.checked});
            updateChoice(otherIndex,event.target.checked ? draftText : "");
          }} />
          <span className="question-choice-chip"><span className="question-choice-check" aria-hidden="true">✓</span>직접 입력</span>
        </label>
      </div>
      {(hasLegacyAnswer || legacyText) && <p className="question-choice-hint">기존 답변: {legacyText || answerFieldsText(fields)}</p>}
      {direct && <label htmlFor={`${id}-other`} className="question-choice-field">보기에 없는 답변을 직접 적어주세요.
        <GrowingTextarea id={`${id}-other`} inputRef={inputRef} className="question-answer-textarea question-choice-textarea"
          value={draftText} maxLength={20_000}
          onChange={event => {
            onChoiceDraft?.({text:event.target.value,selected:true});
            updateChoice(otherIndex,event.target.value);
          }} />
      </label>}
    </fieldset>;
  }
  return <fieldset className={`question-answer-form${form.kind === "numbered" ? " question-numbered-form" : ""}`} disabled={disabled}>
    <legend>{form.title}</legend>
    {form.labels.map((label,index) => <label key={index} htmlFor={`${id}-${index}`}>
      <span>{form.kind === "numbered" ? `${index+1}.` : label}</span>
      <textarea id={`${id}-${index}`} ref={index===0?inputRef:undefined}
        className="question-answer-textarea" value={fields[index]??""}
        rows={form.kind === "numbered" ? 2 : undefined}
        maxLength={Math.max(0,20_000-answerFieldsText(fields.filter((_,i)=>i!==index)).length-
          (fields.some((value,i)=>i!==index&&value.trim())?2:0))}
        aria-label={`${form.title} · ${form.kind==="numbered"?`항목 ${index+1}`:label}`}
        onChange={event=>{
          update(index,event.target.value);
        }} />
    </label>)}
  </fieldset>;
}
