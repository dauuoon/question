"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Toast } from "@/app/toast";

export function ParticipantTheme({ initialTheme, children }: {
  initialTheme: "light" | "dark"; children: ReactNode;
}) {
  const [theme, setTheme] = useState(initialTheme);
  const [message, setMessage] = useState("");
  const [restricted, setRestricted] = useState<boolean | null>(null);
  const label = theme === "light" ? "다크모드로 변경" : "라이트모드로 변경";

  useEffect(() => {
    const query = window.matchMedia("(max-width: 400px)");
    const update = () => setRestricted(query.matches);
    update();
    query.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      query.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  function toggle() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.cookie = `why-box-theme=${next}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    const saved = document.cookie.split("; ").includes(`why-box-theme=${next}`);
    setMessage(saved ? "" : "모드는 변경되었지만 설정을 저장하지 못했습니다. 브라우저의 쿠키 설정을 확인해주세요.");
  }

  return (
    <div className="app-shell participant-shell" data-theme={restricted !== false ? "light" : theme}>
      {restricted === false ? <>
        {children}
        <div className="theme-floating">
          {message ? <Toast message={message} error /> : null}
          <button type="button" className="theme-toggle" aria-label={label} title={label}
            aria-pressed={theme === "dark"} onClick={toggle}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {theme === "light" ? <path d="M20.8 13.1A9 9 0 0 1 10.9 3.2a9 9 0 1 0 9.9 9.9Z" /> : <>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </>}
            </svg>
          </button>
        </div>
      </> : <main className="participant-restriction" aria-label="이용 안내">
        <svg className="participant-restriction-icon" viewBox="0 0 96 80" fill="none"
          stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true" focusable="false">
          <rect x="3" y="4" width="60" height="45" rx="5" />
          <path d="M23 60h20m-10-11v11m-16 5h32" />
          <rect x="68" y="20" width="25" height="48" rx="4" />
          <path d="M77 26h7m-4 36h2" />
        </svg>
        <p>원활한 디자인 이미지 확인과 질문 작성을 위해 태블릿 또는 PC에서 접속해 주세요.</p>
      </main>}
    </div>
  );
}
