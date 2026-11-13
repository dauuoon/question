"use client";

import { useEffect,useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { getPublicEnv } from "@/lib/env";
import Link from "next/link";

export default function TestEnvironmentVerification() {
  const [status,setStatus]=useState("Checking TEST browser configuration");
  const [generation,setGeneration]=useState("");
  useEffect(()=>{
    const env=getPublicEnv();
    const ref=new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
    if(ref!=="njtgxnlxlhxpbiekbgmv") {
      setStatus("FAIL: browser project mismatch");
      return;
    }
    const client=createSupabaseBrowserClient();
    let active=true;
    void client.auth.getSession().then(({data,error})=>{
      if(!active)return;
      setStatus(error?"FAIL: TEST session read":
        `TEST browser Auth: ${ref}; ${data.session?"session present":"no authenticated session"}`);
    });
    void fetch("/api/test-environment",{cache:"no-store"}).then(async response=>{
      if(!response.ok)throw new Error("TEST server isolation verification failed");
      const data:unknown=await response.json();
      if(typeof data!=="object"||data===null||!("questionGenerationEnabled" in data)) {
        throw new Error("TEST server verification response is invalid");
      }
      if(active)setGeneration(data.questionGenerationEnabled===true?
        `최초 질문 생성이 활성화되어 있습니다. ${"briefingMode" in data&&data.briefingMode==="openai"?
          "세션 종료 시 필요한 답변을 자동으로 다듬고 실제 AI 브리핑을 생성합니다.":
          "세션 종료 브리핑은 모의 결과입니다."} 실제 AI 호출에는 비용이 발생하며 답변은 별도 테스트 DB에 저장됩니다.`:
        "최초 질문 생성은 비활성화되어 있습니다.");
    }).catch(error=>{
      if(active)setGeneration(error instanceof Error?error.message:"TEST server verification failed");
    });
    return ()=>{active=false;};
  },[]);
  return <main><h1>TEST runtime verification</h1><p role="status">{status}</p>
    <p>{generation}</p>
    <p>이 페이지에서는 로그인, 데이터 변경 또는 AI 호출을 실행하지 않습니다. 기존 참가자 DB와 분리된 3001번 테스트 앱입니다.</p>
    <p>재생성·후속 질문 AI는 비활성화되어 있습니다.</p>
    <Link href="/login">테스트 계정으로 로그인</Link></main>;
}
