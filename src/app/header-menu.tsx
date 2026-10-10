"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

export function HeaderMenu({ label, children }: { label: string; children: ReactNode }) {
  const path = usePathname();
  return <Menu key={path} label={label}>{children}</Menu>;
}

function Menu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); toggle.current?.focus(); }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return <div className="header-menu" ref={container}>
    <button type="button" className="menu-toggle button-secondary" ref={toggle}
      aria-label={open ? "메뉴 닫기" : "메뉴 열기"} aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(!open)}>
      <svg width="24" height="24" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        {open ? <path d="m6 6 12 12M18 6 6 18" /> : <path d="M4 6h16M4 12h16M4 18h16" />}
      </svg>
    </button>
    <nav id={id} aria-label={label} className={open ? "menu-open" : ""}
      onClick={(event) => { if (event.target instanceof Element && event.target.closest("a, button")) setOpen(false); }}>
      {children}
    </nav>
  </div>;
}
