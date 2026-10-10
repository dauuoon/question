"use client";

import { errorCatalog } from "@/lib/errors/catalog";
import { Toast } from "./toast";

export default function AppError({ reset }: { reset: () => void }) {
  return (
    <main className="page-container">
      <section className="content-stack">
        <h1 className="page-title">화면을 불러오지 못했습니다</h1>
        <Toast error message={`${errorCatalog["UNKNOWN-001"].participantMessage} (UNKNOWN-001)`} />
        <button type="button" onClick={reset}>다시 시도</button>
      </section>
    </main>
  );
}
