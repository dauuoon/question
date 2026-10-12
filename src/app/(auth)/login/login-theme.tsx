"use client";

import { useState, type ReactNode } from "react";
import { ThemeFloatingActions } from "@/app/theme-floating-actions";

export function LoginTheme({ initialTheme, children }: {
  initialTheme: "light" | "dark";
  children: ReactNode;
}) {
  const [theme, setTheme] = useState(initialTheme);
  const [message, setMessage] = useState("");

  function toggle() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.cookie = `why-box-theme=${next}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    const saved = document.cookie.split("; ").includes(`why-box-theme=${next}`);
    setMessage(saved ? "" : "모드는 변경되었지만 설정을 저장하지 못했습니다. 브라우저의 쿠키 설정을 확인해주세요.");
  }

  return <div className="app-shell participant-shell auth-theme-shell" data-theme={theme}>
    {children}
    <ThemeFloatingActions theme={theme} message={message} onToggle={toggle} />
  </div>;
}
