"use client";

import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import { useFormStatus } from "react-dom";
import { LoadingState } from "@/app/loading-state";
import { Toast } from "@/app/toast";

function LoginSubmitButton() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} aria-busy={pending}>
    {pending ? <LoadingState variant="button">로그인 중</LoadingState> : "로그인"}
  </button>;
}

function LoginFields() {
  const { pending } = useFormStatus();
  return <fieldset className="login-fields" disabled={pending}>
    <div className="auth-field">
      <label htmlFor="identifier">아이디</label>
      <input id="identifier" name="identifier" autoComplete="username" required />
    </div>
    <div className="auth-field">
      <label htmlFor="password">비밀번호</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required />
    </div>
  </fieldset>;
}

function LoginSubmissionReset({ reset }: { reset: () => void }) {
  const { pending } = useFormStatus();
  useEffect(() => { if (!pending) reset(); }, [pending, reset]);
  return null;
}

export function LoginForm({ action, errorMessage }: {
  action: NonNullable<ComponentProps<"form">["action"]>;
  errorMessage?: string;
}) {
  const submitted = useRef(false);
  const resetSubmitted = useCallback(() => { submitted.current = false; }, []);
  return <form action={action} className="form-stack" onSubmit={event => {
    if (submitted.current) event.preventDefault();
    else submitted.current = true;
  }}>
    <LoginSubmissionReset reset={resetSubmitted} />
    <LoginFields />
    {errorMessage ? <Toast error message={errorMessage} /> : null}
    <LoginSubmitButton />
  </form>;
}
