"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { bubblePosition } from "@/lib/question-generation/bubble-position";
import type { DisplayQuestion } from "@/lib/question-generation/view-contract";

export function QuestionBubble({ frame, anchor, question, obstacles, onClose }: {
  frame: RefObject<HTMLDivElement | null>;
  anchor: HTMLButtonElement;
  question: DisplayQuestion;
  obstacles: Array<{ left: number; right: number; top: number; bottom: number }>;
  onClose: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ReturnType<typeof bubblePosition> | null>(null);
  useLayoutEffect(() => {
    const parent = frame.current;
    const bubble = element.current;
    if (!parent || !bubble) return;
    function measure() {
      if (!parent || !bubble || !anchor.isConnected) return;
      const box = parent.getBoundingClientRect();
      const pin = anchor.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const scaleX = parent.clientWidth / box.width;
      const scaleY = parent.clientHeight / box.height;
      // Very wide/tall images can be too thin for an accessible close button.
      // Use the surrounding image stage in that case, keeping the pin as anchor.
      const bounds = parent.clientHeight < 80 || parent.clientWidth < 120 ?
        parent.parentElement?.getBoundingClientRect() ?? box : box;
      const next = bubblePosition({ width: bounds.width * scaleX, height: bounds.height * scaleY }, {
        left: (pin.left - bounds.left) * scaleX, right: (pin.right - bounds.left) * scaleX,
        top: (pin.top - bounds.top) * scaleY, bottom: (pin.bottom - bounds.top) * scaleY,
      }, (bubble.querySelector("p")?.scrollHeight ?? bubble.scrollHeight) + 32,
      obstacles.map(obstacle=>({
        left:(obstacle.left+box.left-bounds.left)*scaleX,
        right:(obstacle.right+box.left-bounds.left)*scaleX,
        top:(obstacle.top+box.top-bounds.top)*scaleY,
        bottom:(obstacle.bottom+box.top-bounds.top)*scaleY,
      })));
      next.left += (bounds.left - box.left) * scaleX;
      next.top += (bounds.top - box.top) * scaleY;
      setPosition(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    if (parent.parentElement) observer.observe(parent.parentElement);
    observer.observe(anchor);
    observer.observe(bubble);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [frame, anchor, question.question_text, obstacles]);
  return <div ref={element} id="question-pin-bubble" className="question-bubble"
    role="region" aria-label={`질문 ${question.slot_index} 말풍선`}
    style={position ? { left: position.left, top: position.top, width: position.width,
      maxHeight: position.maxHeight } : { visibility: "hidden" }}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <button type="button" className="question-bubble-close" aria-label="질문 말풍선 닫기"
      onClick={onClose}>×</button>
    <p>{question.question_text}</p>
  </div>;
}
