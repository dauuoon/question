"use client";

import { useActionState, useEffect, useRef } from "react";
import { createDraftSession } from "./actions";
import { initialFormResult } from "@/lib/forms";
import { Toast } from "@/app/toast";

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
      <button type="submit" disabled={pending}>{pending ? "준비 중…" : label}</button>
      {state.message ? <Toast message={state.message} error /> : null}
    </form>
  );
}
