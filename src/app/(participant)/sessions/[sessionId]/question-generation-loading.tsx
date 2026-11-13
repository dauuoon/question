"use client";

import { useEffect, useRef, useState } from "react";
import { LoadingState } from "@/app/loading-state";

export function QuestionGenerationLoading({ message = "질문을 생성하고 있어요···",
  startedAt = null, resumeElapsedMs = null, clockActive = true }: {
  message?: string; startedAt?: number | null; resumeElapsedMs?: number | null; clockActive?: boolean;
}) {
  const anchor = useRef<number | null>(null);
  const initialElapsed = useRef(resumeElapsedMs);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  useEffect(() => {
    if (!clockActive || (startedAt === null && initialElapsed.current === null)) return;
    if (anchor.current === null) anchor.current = Date.now();
    const timer = setInterval(() => {
      const elapsed = startedAt === null ?
        (initialElapsed.current ?? 0) + Date.now() - (anchor.current ?? Date.now()) : Date.now() - startedAt;
      setElapsedMs(Math.max(0, elapsed));
    }, 1000);
    return () => clearInterval(timer);
  }, [clockActive, startedAt]);
  const seconds = Math.floor((elapsedMs ?? initialElapsed.current ?? 0) / 1000);
  return <LoadingState variant="overlay">
    {message}
    {clockActive && (startedAt !== null || initialElapsed.current !== null) ?
      <span className="question-generation-elapsed" aria-live="off">경과 시간 {Math.floor(seconds / 60)}분 {seconds % 60}초</span> : null}
  </LoadingState>;
}
