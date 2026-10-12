"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { Toast } from "./toast";
import { MANUAL_PDF_PATH } from "@/lib/manual";

export function ThemeFloatingActions({ theme, message, onToggle }: {
  theme: "light" | "dark";
  message: string;
  onToggle: () => void;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const manualButton = useRef<HTMLButtonElement>(null);
  const manualDialog = useRef<HTMLElement>(null);
  const manualCloseButton = useRef<HTMLButtonElement>(null);
  const label = theme === "light" ? "다크모드로 변경" : "라이트모드로 변경";
  const manualUrl = MANUAL_PDF_PATH;

  useEffect(() => {
    if (!manualOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    manualCloseButton.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setManualOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = manualDialog.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], iframe[tabindex="0"]',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      manualButton.current?.focus();
    };
  }, [manualOpen]);

  return <div className="theme-floating">
    {message ? <Toast message={message} error /> : null}
    <button ref={manualButton} type="button" className="theme-toggle"
      aria-label="사용자 매뉴얼 열기" title="사용자 매뉴얼 열기"
      aria-haspopup="dialog" aria-expanded={manualOpen} onClick={() => setManualOpen(true)}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 6.5c-1.8-1.4-4.7-2-8-1.5v13c3.3-.5 6.2.1 8 1.5m0-13c1.8-1.4 4.7-2 8-1.5v13c-3.3-.5-6.2.1-8 1.5m0-13v13" />
      </svg>
    </button>
    <button type="button" className="theme-toggle" aria-label={label} title={label}
      aria-pressed={theme === "dark"} onClick={onToggle}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {theme === "light" ? <path d="M20.8 13.1A9 9 0 0 1 10.9 3.2a9 9 0 1 0 9.9 9.9Z" /> : <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </>}
      </svg>
    </button>
    {manualOpen ? createPortal(
      <div className="manual-viewer-backdrop" onMouseDown={event => {
        if (event.target === event.currentTarget) setManualOpen(false);
      }}>
        <section ref={manualDialog} className="manual-viewer" role="dialog" aria-modal="true"
          aria-labelledby="manual-viewer-title">
          <header className="manual-viewer-header">
            <h2 id="manual-viewer-title">WHY BOX 사용자 매뉴얼</h2>
            <button ref={manualCloseButton} type="button" className="manual-viewer-close"
              aria-label="매뉴얼 닫기" onClick={() => setManualOpen(false)}>
              <span aria-hidden="true">×</span>
            </button>
          </header>
          <iframe className="manual-viewer-frame" src={manualUrl} title="WHY BOX 사용자 매뉴얼 PDF"
            tabIndex={0} />
          <a className="manual-viewer-fallback" href={manualUrl} target="_blank"
            rel="noopener noreferrer">PDF가 보이지 않나요? 새 탭에서 열기</a>
        </section>
      </div>,
      document.body,
    ) : null}
  </div>;
}
