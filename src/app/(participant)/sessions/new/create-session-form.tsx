"use client";

import { useActionState, useEffect, useRef } from "react";
import { createDraftSession } from "./actions";
import { initialFormResult } from "@/lib/forms";
import { Toast } from "@/app/toast";
import { LoadingState } from "@/app/loading-state";

export function CreateSessionForm({ autoStart = false, label = "새 성찰 시작" }: {
  autoStart?: boolean; label?: string;
}) {
  const [state, action, pending] = useActionState(createDraftSession, initialFormResult);
  const form = useRef<HTMLFormElement>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    form.current?.requestSubmit();
  }, [autoStart]);
  return (
    <form ref={form} action={action} className="form-stack">
      {autoStart && !state.message ? <LoadingState variant="screen">이전 작업을 확인하고 새 성찰을 준비하고 있어요.</LoadingState> :
        <button type="submit" disabled={pending}>
          {pending ? <LoadingState variant="button">준비 중…</LoadingState> : label}
        </button>}
      {state.message ? <Toast message={state.message} error /> : null}
    </form>
  );
}
