"use client";

import { useEffect, useId, useRef, useState } from "react";
import { DESIGN_CATEGORIES } from "@/lib/constants/research-options";

export function CategorySelect({ id, value, disabled, onChange }: {
  id: string; value: string; disabled: boolean; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const options = DESIGN_CATEGORIES.flatMap((group) => group.items.map((item) => ({ ...item })));
  const selected = options.find((item) => item.id === value);

  useEffect(() => {
    if (!open) return;
    const active = list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ??
      list.current?.querySelector<HTMLButtonElement>('[role="option"]');
    active?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  return <div className="category-select" ref={container} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button id={id} ref={trigger} type="button" className="category-trigger button-secondary"
      data-selected={Boolean(selected)}
      disabled={disabled} aria-label={`디자인 분류: ${selected?.label ?? "선택해주세요"}`}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
      onClick={() => setOpen(!open)} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      }}>
      <span className={selected ? "" : "category-placeholder"}>{selected?.label ?? "디자인 분류를 선택해주세요"}</span>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
    {open && !disabled ? <div id={listId} ref={list} role="listbox" aria-label="디자인 분류" className="category-dropdown"
      onKeyDown={(event) => {
        const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
        const current = buttons.findIndex((button) => button === document.activeElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
            (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        } else if (event.key === "Escape") {
          event.preventDefault(); setOpen(false); trigger.current?.focus();
        }
      }}>
      {DESIGN_CATEGORIES.map((group) => <div key={group.id} role="group" aria-label={group.label} className="category-group">
        <p aria-hidden="true" className="category-group-title">{group.label}</p>
        {group.items.map((item) => <button key={item.id} type="button" role="option" tabIndex={-1}
          className="category-option" aria-selected={value === item.id} onClick={() => {
            onChange(item.id); setOpen(false); trigger.current?.focus();
          }}>
          <span>{item.label}</span><span aria-hidden="true">{value === item.id ? "✓" : ""}</span>
        </button>)}
      </div>)}
    </div> : null}
  </div>;
}
