"use client";

import { useState } from "react";
import { Toast } from "@/app/toast";
import type { ResearchExport } from "@/lib/admin/research-workbook";

export function ResearchDownload({ kind, id, label }: ResearchExport & { label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function download() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ kind });
      if (id) params.set("id", id);
      const response = await fetch(`/api/admin/research-export?${params}`, { cache: "no-store" });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(typeof body.message === "string" ? body.message : "다운로드하지 못했습니다.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `whybox-${kind}.xlsx`;
      document.body.append(link);
      link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "다운로드하지 못했습니다.");
    } finally { setBusy(false); }
  }
  return <>
    <button type="button" className="button-secondary" disabled={busy}
      aria-busy={busy} onClick={() => void download()}>{busy ? "Excel 준비 중…" : label}</button>
    <Toast message={error} error />
  </>;
}
