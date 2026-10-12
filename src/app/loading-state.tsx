import { useEffect, useState, type ReactNode } from "react";

export const LOADING_TIPS = [
  "질문에 답하다 보면 미처 발견하지 못한 생각을 마주할 수 있어요.",
  "구체적인 피드백 대신, 스스로 생각을 돌아볼 수 있는 질문을 만들고 있어요.",
  "익숙하게 지나쳤던 생각도 질문을 통해 다시 살펴볼 수 있어요.",
  "왜 그렇게 디자인했는지 스스로 돌아보는 시간을 가져보세요.",
  "하나의 질문이 새로운 관점으로 이어질 수 있어요.",
  "당연하게 여겼던 선택에도 나름의 판단 근거가 있을 수 있어요.",
  "질문에 답하면서 디자인 의도를 조금 더 명확하게 정리할 수 있어요.",
  "지금의 생각을 기록하면 나중에 디자인 과정을 돌아보는 데 도움이 될 수 있어요.",
] as const;

export function LoadingState({ children, variant = "inline", className = "", showSpinner = true,
  "aria-labelledby": ariaLabelledBy }: {
  children: ReactNode;
  variant?: "screen" | "inline" | "button" | "overlay";
  className?: string;
  showSpinner?: boolean;
  "aria-labelledby"?: string;
}) {
  const [tipIndex, setTipIndex] = useState(0);
  const [tipVisible, setTipVisible] = useState(true);
  useEffect(() => {
    if (variant !== "overlay") return;
    let fadeTimer: ReturnType<typeof setTimeout> | undefined;
    const rotationTimer = setInterval(() => {
      setTipVisible(false);
      fadeTimer = setTimeout(() => {
        setTipIndex(index => (index + 1) % LOADING_TIPS.length);
        setTipVisible(true);
      }, 220);
    }, 4500);
    return () => {
      clearInterval(rotationTimer);
      if (fadeTimer !== undefined) clearTimeout(fadeTimer);
    };
  }, [variant]);
  const Container = variant === "screen" || variant === "overlay" ? "div" : "span";
  return <Container className={`loading-state loading-state-${variant}${className ? ` ${className}` : ""}`}
    role="status" aria-live="polite" aria-busy="true" aria-labelledby={ariaLabelledBy}>
    {showSpinner ? <span className="loading-state-spinner" aria-hidden="true" /> : null}
    <span>{children}</span>
    {variant === "overlay" ? <span className={`loading-state-tip${tipVisible ? " is-visible" : ""}`}
      aria-hidden="true">Tip. {LOADING_TIPS[tipIndex]}</span> : null}
  </Container>;
}
