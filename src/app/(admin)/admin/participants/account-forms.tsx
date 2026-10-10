"use client";

import { useActionState } from "react";
import { createParticipant, manageParticipant } from "./actions";
import { initialFormResult } from "@/lib/forms";
import { Toast } from "@/app/toast";

export function CreateParticipantForm() {
  const [state, action, pending] = useActionState(createParticipant, initialFormResult);
  return (
    <section className="notice-card account-create" aria-label="계정 생성">
      <form action={action} className="form-stack">
        <label htmlFor="participant-code">아이디</label>
        <input id="participant-code" name="participant_code" placeholder="P01" pattern="[Pp][0-9]{2,}" required autoComplete="off" />
        <label htmlFor="temporary-password">비밀번호</label>
        <input id="temporary-password" name="password" type="password" minLength={6} required autoComplete="new-password" />
        <button className="button-dark" type="submit" disabled={pending}>{pending ? "생성 중…" : "계정 생성"}</button>
        {state.message ? <Toast message={state.message} error={!!state.errorCode} /> : null}
      </form>
    </section>
  );
}

export function ManageParticipantForm({ id, active }: { id: string; active: boolean }) {
  const [state, action, pending] = useActionState(manageParticipant, initialFormResult);
  return (
    <form action={action} className="form-stack">
      <input type="hidden" name="participant_id" value={id} />
      <button type="submit" name="operation" value={active ? "deactivate" : "activate"}
        className="button-secondary" disabled={pending}>
        {active ? "비활성화" : "활성화"}
      </button>
      <label htmlFor={`password-${id}`}>새 임시 비밀번호</label>
      <input id={`password-${id}`} name="password" type="password" minLength={6} autoComplete="new-password" />
      <button type="submit" name="operation" value="reset_password" disabled={pending}>비밀번호 재설정</button>
      {state.message ? <Toast message={state.message} error={!!state.errorCode} /> : null}
    </form>
  );
}
