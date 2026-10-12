"use client";

import { useEffect, useState } from "react";
import { LoadingState } from "@/app/loading-state";

const messages = [
  "WHY BOX는 정답보다 생각을 이어갈 질문을 만듭니다.",
  "질문에 답하다 보면 작업의 의도를 다시 발견할 수 있어요.",
  "익숙하게 지나친 선택도 질문을 만나면 다시 보일 수 있어요.",
  "좋고 나쁨을 판단하기보다, 왜 그렇게 디자인했는지 돌아봅니다.",
  "하나의 질문이 새로운 관점과 다음 선택으로 이어질 수 있어요.",
] as const;

export function QuestionGenerationLoading() {
  const [messageIndex,setMessageIndex]=useState(0);
  const [visible,setVisible]=useState(true);
  useEffect(()=>{
    let transition:ReturnType<typeof setTimeout>|undefined;
    const interval=setInterval(()=>{
      setVisible(false);
      transition=setTimeout(()=>{
        setMessageIndex(index=>(index+1)%messages.length);
        setVisible(true);
      },250);
    },4500);
    return ()=>{
      clearInterval(interval);
      if(transition)clearTimeout(transition);
    };
  },[]);
  return <LoadingState variant="screen" className="question-generation-loading"
    aria-labelledby="question-generation-loading-title" showSpinner={false}>
    <img src="/images/icon.png" width="112" height="112" alt="" className="question-generation-icon" />
    <h1 id="question-generation-loading-title" className="question-generation-title">
      질문을 생성 중입니다.
    </h1>
    <p className={`question-generation-message${visible?" is-visible":""}`} aria-hidden="true">
      {messages[messageIndex]}
    </p>
  </LoadingState>;
}
