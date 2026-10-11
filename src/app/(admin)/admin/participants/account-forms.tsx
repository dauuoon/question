"use client";

import { useActionState } from "react";
import { createParticipant, manageParticipant, changeAccountType } from "./actions";
import { initialFormResult } from "@/lib/forms";
import { Toast } from "@/app/toast";
import { accountTypeLabel, type AccountType } from "@/lib/accounts/type";

export function CreateParticipantForm() {
  const [state, action, pending] = useActionState(createParticipant, initialFormResult);
  return (
    <section className="notice-card account-create" aria-label="계정 생성">
      <form action={action} className="form-stack">
        <label htmlFor="participant-code">아이디</label>
        <input id="participant-code" name="participant_code" placeholder="P01 또는 T01" pattern="[PpTt][0-9]{2,}" required autoComplete="off" />
        <label htmlFor="account-type">계정 유형</label>
        <select id="account-type" name="account_type" defaultValue="" required>
          <option value="" disabled>유형을 명시적으로 선택해주세요</option>
          <option value="P">P · 실제 연구 참여자</option>
          <option value="T">T · 교수님·검토자·개발 테스트</option>
        </select>
        <p className="supporting-copy">아이디 접두어와 무관하게 선택한 유형을 저장합니다. 두 유형의 사용자 기능은 동일합니다.</p>
        <label htmlFor="temporary-password">비밀번호</label>
        <input id="temporary-password" name="password" type="password" minLength={6} required autoComplete="new-password" />
        <button className="button-dark" type="submit" disabled={pending}>{pending ? "생성 중…" : "계정 생성"}</button>
        {state.message ? <Toast message={state.message} error={!!state.errorCode} /> : null}
      </form>
    </section>
  );
}

export function ChangeAccountTypeForm({ id, accountType }: { id: string; accountType: AccountType | null }) {
  const [state, action, pending] = useActionState(changeAccountType, initialFormResult);
  return <details className="account-type-change">
    <summary>계정 유형 변경</summary>
    <form action={action} className="form-stack" key={accountType ?? "unclassified"}>
      <input type="hidden" name="participant_id" value={id} />
      <input type="hidden" name="expected_type" value={accountType ?? ""} />
      <p>현재 {accountTypeLabel(accountType)}</p>
      <label htmlFor={`type-${id}`}>변경할 유형</label>
      <select id={`type-${id}`} name="account_type" defaultValue="" required disabled={pending}>
        <option value="" disabled>선택해주세요</option>
        <option value="P">P · 실제 연구 참여자</option>
        <option value="T">T · 검토·테스트</option>
      </select>
      <label htmlFor={`type-reason-${id}`}>변경 사유 (개인정보·비밀정보 제외)</label>
      <input id={`type-reason-${id}`} name="reason" maxLength={500} required disabled={pending} />
      <label className="account-type-confirm">
        <input name="confirmed" type="checkbox" value="yes" required disabled={pending} />
        이 계정의 기존 기록 전체가 현재 유형에 따라 연구 통계·Excel에 포함되거나 제외되는 것을 확인했습니다.
      </label>
      <button type="submit" className="button-secondary" disabled={pending}>{pending ? "저장 중…" : "확인 후 유형 변경"}</button>
      {state.message ? <Toast message={state.message} error={!!state.errorCode} /> : null}
    </form>
  </details>;
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
