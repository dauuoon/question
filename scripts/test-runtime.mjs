import { cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,symlinkSync,writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname,join,resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath,pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { Buffer } from "node:buffer";
import process from "node:process";
import console from "node:console";
import { createHash } from "node:crypto";

export const TEST_REF="njtgxnlxlhxpbiekbgmv";
export const TEST_HOST="localhost";
export const TEST_PORT=3001;
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");

export function researcherRefinementEnvironment(base,fixture,local,budget,prompt,approved=false) {
  if(base.NODE_ENV==="production"||base.NEXT_PUBLIC_SUPABASE_URL!==`https://${TEST_REF}.supabase.co`||
    fixture.projectRef!==TEST_REF||fixture.purpose!=="researcher-synthetic-sentence-refinement"||
    fixture.stage!=="ready"||fixture.callLimit!==3||
    !/^[0-9a-f-]{36}$/u.test(fixture.participantId??"")||!/^[0-9a-f-]{36}$/u.test(fixture.sessionId??"")) {
    throw new Error("Invalid researcher synthetic fixture; startup blocked");
  }
  if(!approved)return {...base};
  if(!local.OPENAI_API_KEY||local.OPENAI_SENTENCE_REFINEMENT_MODEL!=="gpt-6-astra") {
    throw new Error("Missing approved researcher refinement key/model");
  }
  return {...base,
    OPENAI_API_KEY:local.OPENAI_API_KEY,OPENAI_SENTENCE_REFINEMENT_ENABLED:"true",
    OPENAI_SENTENCE_REFINEMENT_MODEL:"gpt-6-astra",
    WHY_BOX_RESEARCHER_REFINEMENT:"approved",WHY_BOX_RESEARCHER_PARTICIPANT:fixture.participantId,
    WHY_BOX_RESEARCHER_SESSION:fixture.sessionId,WHY_BOX_RESEARCHER_BUDGET:budget,
    WHY_BOX_TEST_PROMPT_HASH:createHash("sha256").update(prompt).digest("hex"),
  };
}

export function prepareResearcherRefinementSnapshot(app) {
  const servicePath=join(app,"src/lib/ai/server/sentence-refinement.ts");
  const source=readFileSync(servicePath,"utf8");
  const constructor='new OpenAI({apiKey:config.apiKey,maxRetries:0,timeout:SENTENCE_REFINEMENT_TIMEOUT_MS,logLevel:"off"})';
  if(source.split(constructor).length!==2||!source.includes("max_output_tokens:4000"))throw new Error("Refinement SDK contract changed");
  writeFileSync(servicePath,'import { researcherRefinementFetch } from "./researcher-refinement";\n'+
    source.replace(constructor,constructor.replace('logLevel:"off"','logLevel:"off",fetch:researcherRefinementFetch'))
      .replace("max_output_tokens:4000","max_output_tokens:800")
      .replace("if(error instanceof SentenceRefinementError) throw error;",
        "if(error instanceof SentenceRefinementError) throw error;\n    if(error instanceof OpenAI.APIConnectionError && error.cause instanceof SentenceRefinementError) throw error.cause;"));
  const routePath=join(app,"src/app/api/sentence-refinement/route.ts");
  const route=readFileSync(routePath,"utf8");
  const editable="await requireEditableQuestion(caller,userId,parsed.data.question_id,controller.signal);";
  if(!route.includes(editable))throw new Error("Refinement ownership contract changed");
  writeFileSync(routePath,'import { assertResearcherScope } from "@/lib/ai/server/researcher-refinement";\n'+
    route.replace(editable,`const scopedQuestion=${editable} assertResearcherScope(userId,scopedQuestion.session_id);`));
  cpSync(join(root,"scripts/test-runtime/researcher-refinement.ts"),join(app,"src/lib/ai/server/researcher-refinement.ts"));
}

function assertKey(key,expectedRole) {
  if(!key?.trim())throw new Error(`Missing TEST ${expectedRole} key`);
  if(key.split(".").length===3) {
    let claim;
    try {claim=JSON.parse(Buffer.from(key.split(".")[1],"base64url").toString());}
    catch {throw new Error(`Invalid TEST ${expectedRole} key format`);}
    if(claim.ref!==TEST_REF||claim.role!==expectedRole)throw new Error(`TEST ${expectedRole} key project/role mismatch`);
  } else if(expectedRole==="anon"?!key.startsWith("sb_publishable_"):!key.startsWith("sb_secret_")) {
    throw new Error(`Invalid TEST ${expectedRole} key type`);
  }
}

export function testRuntimeEnvironment(test,inherited=process.env) {
  if(test.SUPABASE_TEST_URL!==`https://${TEST_REF}.supabase.co`)throw new Error("TEST Supabase project mismatch; startup blocked");
  assertKey(test.SUPABASE_TEST_PUBLISHABLE_KEY,"anon");
  assertKey(test.SUPABASE_TEST_SERVICE_ROLE_KEY,"service_role");
  const clean=Object.fromEntries(Object.entries(inherited).filter(([name])=>
    !/^(?:OPENAI_|SUPABASE_|NEXT_PUBLIC_|NEXT_|__NEXT_|WHY_BOX_)/u.test(name)));
  return {
    ...clean,
    NODE_ENV:"development",
    NEXT_PUBLIC_SUPABASE_URL:test.SUPABASE_TEST_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:test.SUPABASE_TEST_PUBLISHABLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY:test.SUPABASE_TEST_SERVICE_ROLE_KEY,
    OPENAI_API_KEY:"",
    OPENAI_SENTENCE_REFINEMENT_ENABLED:"false",
    OPENAI_SENTENCE_REFINEMENT_MODEL:"",
    OPENAI_CONTEXT_DRAFT_ENABLED:"false",
    OPENAI_CONTEXT_DRAFT_MODEL:"",
    OPENAI_QUESTION_GENERATION_MODEL:"",
    OPENAI_QUESTION_REGENERATION_ENABLED:"false",
    OPENAI_QUESTION_REGENERATION_MODEL:"",
    SESSION_BRIEFING_MOCK_ENABLED:"true",
    OPENAI_SESSION_BRIEFING_ENABLED:"false",
    OPENAI_SESSION_BRIEFING_MODEL:"",
    SESSION_IMAGE_DELETION_ENABLED:"false",
    NEXT_TELEMETRY_DISABLED:"1",
  };
}

async function checkPort() {
  await new Promise((resolvePromise,reject)=>{
    const probe=createServer();
    probe.once("error",()=>reject(new Error("TEST port 3001 unavailable; will not select another port")));
    probe.listen(TEST_PORT,TEST_HOST,()=>probe.close(resolvePromise));
  });
}

export async function startTestRuntime() {
  const test=parseEnv(readFileSync(join(root,".env.storage-test.local"),"utf8"));
  let env=testRuntimeEnvironment(test);
  const e2e=process.argv.includes("--refinement-e2e");
  const researcher=process.argv.includes("--refinement-researcher");
  if(e2e&&researcher)throw new Error("Choose only one TEST refinement mode");
  if(process.argv.includes("--approve-live-refinement")&&!researcher)throw new Error("Researcher approval requires researcher mode");
  if(researcher) {
    const fixture=JSON.parse(readFileSync(join(root,".test-runtime/researcher-refinement.json"),"utf8"));
    const approved=process.argv.includes("--approve-live-refinement");
    const prompt=readFileSync(join(root,"src/lib/ai/prompts/sentence-refinement-v1.1.ts"),"utf8")
      .match(/export const SENTENCE_REFINEMENT_PROMPT\s*=\s*`([\s\S]*?)`;/u)?.[1];
    if(!prompt)throw new Error("Refinement prompt format changed");
    const budget=join(root,".test-runtime/researcher-refinement-budget");
    env=researcherRefinementEnvironment(env,fixture,
      approved?parseEnv(readFileSync(join(root,".env.local"),"utf8")):{},budget,prompt,approved);
    if(approved) {
      const policy=JSON.parse(readFileSync(join(budget,"policy.json"),"utf8"));
      if(policy.participantId!==fixture.participantId||policy.sessionId!==fixture.sessionId||
        policy.callLimit!==3||policy.projectRef!==TEST_REF)throw new Error("Researcher budget scope mismatch");
      const headers={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`};
      const user=await globalThis.fetch(`${test.SUPABASE_TEST_URL}/auth/v1/admin/users/${fixture.participantId}`,{headers});
      if(!user.ok)throw new Error("Researcher Auth scope verification failed");
      const data=await user.json();
      if(data.app_metadata?.why_box_fixture!==fixture.purpose||data.app_metadata?.project_ref!==TEST_REF||
        data.user_metadata?.synthetic!==true||data.banned_until&&Date.parse(data.banned_until)>Date.now()) {
        throw new Error("Researcher synthetic identity verification failed");
      }
      const session=await globalThis.fetch(`${test.SUPABASE_TEST_URL}/rest/v1/sessions?id=eq.${fixture.sessionId}&participant_id=eq.${fixture.participantId}&select=status`,{headers});
      if(!session.ok||(await session.json())[0]?.status!=="in_progress")throw new Error("Researcher session verification failed");
    }
  }
  if(e2e) {
    const local=parseEnv(readFileSync(join(root,".env.local"),"utf8"));
    if(!local.OPENAI_API_KEY||local.OPENAI_SENTENCE_REFINEMENT_MODEL!=="gpt-6-astra") {
      throw new Error("Missing approved refinement key/model");
    }
    const budget=join(root,".test-runtime","refinement-e2e-call");
    if(existsSync(budget))throw new Error("TEST live refinement budget already consumed; startup blocked");
    env.OPENAI_API_KEY=local.OPENAI_API_KEY;
    env.OPENAI_SENTENCE_REFINEMENT_ENABLED="true";
    env.OPENAI_SENTENCE_REFINEMENT_MODEL="gpt-6-astra";
    env.WHY_BOX_TEST_REFINEMENT_BUDGET=budget;
    const prompt=readFileSync(join(root,"src/lib/ai/prompts/sentence-refinement-v1.1.ts"),"utf8")
      .match(/export const SENTENCE_REFINEMENT_PROMPT\s*=\s*`([\s\S]*?)`;/u)?.[1];
    if(!prompt)throw new Error("Refinement prompt format changed; E2E startup blocked");
    env.WHY_BOX_TEST_PROMPT_HASH=createHash("sha256").update(prompt).digest("hex");
  }
  const response=await globalThis.fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`,{
    headers:{apikey:env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY},
    signal:globalThis.AbortSignal.timeout(15_000),
  });
  if(!response.ok)throw new Error(`TEST Auth connectivity failed (HTTP ${response.status})`);
  await checkPort();
  const staging=join(root,".test-runtime");
  mkdirSync(staging,{recursive:true,mode:0o700});
  const app=mkdtempSync(join(staging,"app-"));
  // A source snapshot keeps Next's generated types, caches and dotenv loading away from Production.
  for(const name of ["src","public","package.json","package-lock.json","next.config.ts","tsconfig.json"]) {
    const source=join(root,name);
    if(existsSync(source))cpSync(source,join(app,name),{recursive:true});
  }
  const verification=join(app,"src/app/test-environment");
  const verificationAPI=join(app,"src/app/api/test-environment");
  mkdirSync(verification,{recursive:true});
  mkdirSync(verificationAPI,{recursive:true});
  cpSync(join(root,"scripts/test-runtime/verification-page.tsx"),join(verification,"page.tsx"));
  cpSync(join(root,"scripts/test-runtime/verification-route.ts"),join(verificationAPI,"route.ts"));
  if(researcher&&env.WHY_BOX_RESEARCHER_REFINEMENT==="approved") {
    prepareResearcherRefinementSnapshot(app);
  }
  if(e2e) {
    const servicePath=join(app,"src/lib/ai/server/sentence-refinement.ts");
    const source=readFileSync(servicePath,"utf8");
    const constructor="new OpenAI({apiKey:config.apiKey,maxRetries:0,timeout:SENTENCE_REFINEMENT_TIMEOUT_MS,logLevel:\"off\"})";
    if(source.split(constructor).length!==2)throw new Error("Refinement SDK contract changed; E2E startup blocked");
    writeFileSync(servicePath,'import { refinementBudgetFetch } from "./refinement-budget";\n'+
      source.replace(constructor,constructor.replace('logLevel:"off"','logLevel:"off",fetch:refinementBudgetFetch')));
    cpSync(join(root,"scripts/test-runtime/refinement-budget.ts"),join(app,"src/lib/ai/server/refinement-budget.ts"));
  }
  symlinkSync(join(root,"node_modules"),join(app,"node_modules"),"dir");
  writeFileSync(join(staging,"latest.json"),JSON.stringify({
    app,projectRef:TEST_REF,url:`http://${TEST_HOST}:${TEST_PORT}`,aiEnabled:e2e||env.WHY_BOX_RESEARCHER_REFINEMENT==="approved",
  },null,2)+"\n");
  console.log(`TEST project verified: ${TEST_REF}; Auth HTTP ${response.status}`);
  console.log(`TEST-only app: http://${TEST_HOST}:${TEST_PORT}; ${env.WHY_BOX_RESEARCHER_REFINEMENT==="approved"?
    "researcher refinement only, durable three-call budget, briefing Mock enabled":e2e?
    "sentence refinement only, durable one-call budget, briefing Mock enabled":"external AI disabled, briefing Mock enabled"}; isolated source/cache`);
  const child=spawn(process.execPath,[join(root,"node_modules/next/dist/bin/next"),
    "dev","--webpack","--hostname",TEST_HOST,"--port",String(TEST_PORT)],{cwd:app,env,stdio:"inherit"});
  const forward=signal=>{if(child.pid)child.kill(signal);};
  const interrupt=()=>forward("SIGINT");
  const terminate=()=>forward("SIGTERM");
  process.once("SIGINT",interrupt);
  process.once("SIGTERM",terminate);
  child.once("error",()=>{console.error("TEST Next.js process could not start");process.exitCode=1;});
  child.once("exit",code=>{
    process.removeListener("SIGINT",interrupt);
    process.removeListener("SIGTERM",terminate);
    process.exitCode=code??1;
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  startTestRuntime().catch(error=>{
    console.error(error.message);
    process.exitCode=1;
  });
}
