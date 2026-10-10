"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export function ScrollHeader({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(false);
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    let previous = window.scrollY;
    let distance = 0;
    let direction = 0;
    const scroll = () => {
      const position = Math.max(0, window.scrollY);
      const delta = position - previous;
      previous = position;
      const nextDirection = Math.sign(delta);
      if (nextDirection !== direction) distance = 0;
      direction = nextDirection;
      distance += delta;
      const interacting = header.current?.contains(document.activeElement) ||
        header.current?.querySelector('[aria-expanded="true"]');
      if (position < 32 || interacting) { setHidden(false); distance = 0; }
      else if (Math.abs(distance) >= 12) { setHidden(distance > 0); distance = 0; }
    };
    window.addEventListener("scroll", scroll, { passive: true });
    return () => window.removeEventListener("scroll", scroll);
  }, []);
  return <header ref={header} className={`topbar${hidden ? " topbar-hidden" : ""}`}
    onFocusCapture={() => setHidden(false)}>{children}</header>;
}
