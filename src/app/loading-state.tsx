import type { ReactNode } from "react";

export function LoadingState({ children, variant = "inline", className = "", showSpinner = true,
  "aria-labelledby": ariaLabelledBy }: {
  children: ReactNode;
  variant?: "screen" | "inline" | "button";
  className?: string;
  showSpinner?: boolean;
  "aria-labelledby"?: string;
}) {
  const Container = variant === "screen" ? "div" : "span";
  return <Container className={`loading-state loading-state-${variant}${className ? ` ${className}` : ""}`}
    role="status" aria-live="polite" aria-busy="true" aria-labelledby={ariaLabelledBy}>
    {showSpinner ? <span className="loading-state-spinner" aria-hidden="true" /> : null}
    <span>{children}</span>
  </Container>;
}
