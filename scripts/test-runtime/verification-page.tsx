"use client";

import { useEffect,useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { getPublicEnv } from "@/lib/env";

export default function TestEnvironmentVerification() {
  const [status,setStatus]=useState("Checking TEST browser configuration");
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
    return ()=>{active=false;};
  },[]);
  return <main><h1>TEST runtime verification</h1><p role="status">{status}</p>
    <p>No login, data write or AI call is performed by this page.</p></main>;
}
