import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { URL } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const owner = "10000000-0000-4000-8000-000000000001";
const sessionId = "20000000-0000-4000-8000-000000000001";
const questionId = "30000000-0000-4000-8000-000000000001";
const requestId = "40000000-0000-4000-8000-000000000001";
const dbRequestId = "50000000-0000-4000-8000-000000000001";
const updatedAt = "2026-10-08T11:00:00.000Z";
const savedAnswer = {
  question_id: questionId, original_answer: "I chose this because it supports the main interaction.",
  refined_answer: null, refinement_used: false, current_answer_version: "original", updated_at: updatedAt,
};

function loader(overrides = {}) {
  const cache = new Map();
  function load(path) {
    const url = path instanceof URL ? path : new URL(`../${path}`, import.meta.url);
    if (cache.has(url.href)) return cache.get(url.href);
    const compiled = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    const module = { exports: {} };
    runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
      name => Object.hasOwn(overrides, name) ? overrides[name] :
        name === "server-only" ? {} :
          name.startsWith("@/") ? load(`src/${name.slice(2)}.ts`) :
            name.startsWith(".") ? load(new URL(`${name}.ts`, url)) : require(name), module, module.exports);
    cache.set(url.href, module.exports);
    return module.exports;
  }
  return load;
}

function setup({ acquired = true, configFailure = false, answer = savedAnswer,
  profile = {participant_code:"P01",account_type:"P",role:"participant",status:"active"},
  env = {OPENAI_QUESTION_FOLLOWUP_ENABLED:"true"},
  recoveryStatus = "generated", recoveryAge = 120_000, finishOutcome,
  realGuards = false, loggedIn = true, sessionOwner = owner, ledgerOwner = owner,
  sessionStatus = "in_progress",
} = {}) {
  const calls = { rpc: [], generation: [], context: [], reads: [], filters: [], admin: 0 };
  const caller = {
    auth:{getUser:async()=>({data:{user:loggedIn?{id:owner}:null},error:null})},
    from(table) {
      calls.reads.push(table);
      const filters=[];
      const query = {
        select() { return query; },
        eq(column,value) {filters.push([column,value]);calls.filters.push({table,column,value});return query;},
        abortSignal(){return query;},limit(){return query;},
        single: async () => ({
          data: table === "sessions" ? {
            primary_category_id: "ux_ui", subcategory_id: "web_design", other_category_text: null,
            stage_id: "idea_concept", additional_context: "Extra context",
          } : { id: questionId, question_text: "What shaped this decision?" },
          error: null,
        }),
        maybeSingle:async()=>{
          const rows={
            profiles:profile?{...profile,id:owner}:null,
            sessions:{id:sessionId,participant_id:sessionOwner,status:sessionStatus},
            questions:{id:questionId,session_id:sessionId,status:"answered",question_kind:"original",is_active_version:true},
            answers:savedAnswer,
            question_followup_requests:{id:dbRequestId,request_id:requestId,participant_id:ledgerOwner,
              session_id:sessionId,status:recoveryStatus,created_at:new Date(Date.now()-recoveryAge).toISOString()},
          };
          const row=rows[table];
          const found=row&&filters.every(([column,value])=>row[column]===value);
          const data=!found?null:table==="questions"?
            {id:row.id,session_id:row.session_id,status:row.status,question_kind:row.question_kind,is_active_version:row.is_active_version}:
            table==="answers"?answer:row;
          return {data,error:null};
        },
        then(resolve) {
          return Promise.resolve({ data: table==="questions"?[]:[{ context_id: "visual_form" }], error: null }).then(resolve);
        },
      };
      return query;
    },
  };
  const admin = { rpc: async (name, args) => {
    calls.rpc.push({ name, args });
    if (name === "begin_question_followup") return { data: {
      id: dbRequestId, request_id: args.p_request_id, status: "reserved",
      result_question_id: null, answer_snapshot: savedAnswer.original_answer,
    }, error: null };
    if (name === "dispatch_question_followup") return { data: {
      request_id: requestId, status: "dispatch_started", acquired,
    }, error: null };
    return { data: {
      id: dbRequestId, request_id: requestId, status: finishOutcome??args.p_outcome,
      result_question_id: (finishOutcome??args.p_outcome) === "generated" ? "60000000-0000-4000-8000-000000000001" : null,
      answer_snapshot: savedAnswer.original_answer,
    }, error: null };
  } };
  const view = { session_id: sessionId, state: "completed" };
  let FollowupError = Error;
  let readAccess;
  const load = loader({
    "@/lib/supabase/server": { createSupabaseServerClient: async () => caller },
    "@/lib/supabase/admin": { createSupabaseAdminClient: () => {calls.admin++;return admin;} },
    "@/lib/question-generation/followup-access": {
      readQuestionFollowupAccess:(client,id)=>readAccess(client,id,env),
    },
    ...(!realGuards?{"@/lib/answers/server": {
      requireActiveParticipant: async () => owner,
      requireEditableQuestion: async () => ({ session_id: sessionId }),
      readAnswer: async () => answer,
      AnswerError: class AnswerError extends Error {},
    }}:{}),
    "@/lib/question-generation/read": { readGenerationView: async () => view },
    "@/lib/ai/server/question-followup-config": {
      QUESTION_FOLLOWUP_TIMEOUT_MS: 60_000,
      questionFollowupConfig: () => {
        if (configFailure) throw new FollowupError("FOLLOWUP-CONFIG");
        return { apiKey: "local-test-key", model: "local-test-model" };
      },
    },
    "@/lib/ai/server/question-followup": {
      generateQuestionFollowup: async (config, context) => {
        calls.generation.push({ config, context });
        return { outcome: "generated", followup_question: "What evidence most influenced that decision?",
          model: "local-test-model", input_tokens: 120, output_tokens: 24 };
      },
    },
  });
  FollowupError = load("src/lib/ai/question-followup-contract.ts").QuestionFollowupError;
  readAccess = load("src/lib/question-generation/followup-access.ts").readQuestionFollowupAccess;
  return { calls, view, route: load("src/app/api/question-followup/route.ts") };
}

async function post(POST, body = {}) {
  const { NextRequest } = require("next/server");
  return POST(new NextRequest("http://localhost/api/question-followup", {
    method: "POST",
    headers: { origin: "http://localhost", host: "localhost", "x-forwarded-proto": "http",
      "content-type": "application/json" },
    body: JSON.stringify({ question_id: questionId, request_id: requestId,
      expected_updated_at: updatedAt, ...body }),
  }));
}

test("follow-up API validates saved answers and makes one provider call with no image payload", async () => {
  const { calls, route } = setup();
  const response = await post(route.POST);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).outcome, "generated");
  assert.deepEqual(calls.rpc.map(call => call.name), [
    "begin_question_followup", "dispatch_question_followup", "finish_question_followup",
  ]);
  assert.equal(calls.generation.length, 1);
  assert.equal(calls.generation[0].context.answer_text, savedAnswer.original_answer);
  assert.equal(calls.generation[0].context.question_text, "What shaped this decision?");
  assert.deepEqual(calls.generation[0].context.context_ids, ["visual_form"]);
  assert.equal("image" in calls.generation[0].context, false);
  assert.equal(calls.rpc.at(-1).args.p_input_tokens, 120);
  assert.equal(calls.rpc.at(-1).args.p_output_tokens, 24);
});

test("lost dispatch race returns pending without calling the provider", async () => {
  const { calls, route } = setup({ acquired: false });
  const response = await post(route.POST);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).outcome, "pending");
  assert.equal(calls.generation.length, 0);
});

test("active P and T participants use real ownership guards without a UUID or code allowlist",async()=>{
  const {NextRequest}=require("next/server");
  for(const [account_type,participant_code] of [["P","P02"],["T","T02"],[null,"legacy"]]) {
    const {route,calls}=setup({realGuards:true,
      profile:{role:"participant",status:"active",account_type,participant_code},
      env:{OPENAI_QUESTION_FOLLOWUP_ENABLED:"true",OPENAI_QUESTION_FOLLOWUP_ALLOWED_USER_IDS:"obsolete-ignored"}});
    assert.equal((await post(route.POST)).status,200);
    assert.equal(calls.generation.length,1);
    assert.equal(calls.rpc[0].args.p_participant_id,owner);
    assert.equal((await route.GET(new NextRequest(
      `http://localhost/api/question-followup?request_id=${requestId}`))).status,200);
    assert.ok(calls.filters.some(f=>f.table==="sessions"&&f.column==="participant_id"&&f.value===owner));
    assert.ok(calls.filters.some(f=>f.table==="question_followup_requests"&&f.column==="participant_id"&&f.value===owner));
  }
});

test("real guards reject anonymous, inactive, administrator and foreign-session generation before trusted writes",async()=>{
  for(const options of [
    {loggedIn:false},
    {profile:{role:"participant",status:"deactivated"}},
    {profile:{role:"admin",status:"active"}},
    {sessionOwner:dbRequestId},
    {sessionStatus:"completed"},
  ]) {
    const {route,calls}=setup({realGuards:true,...options});
    const response=await post(route.POST);
    assert.equal(response.status,options.sessionStatus?409:403);
    assert.equal(calls.admin,0);
    assert.equal(calls.rpc.length,0);
    assert.equal(calls.generation.length,0);
  }
});

test("GET cannot read or expire another participant's request",async()=>{
  const {NextRequest}=require("next/server");
  for(const options of [{ledgerOwner:dbRequestId},{loggedIn:false},
    {profile:{role:"admin",status:"active"}},{profile:{role:"participant",status:"deactivated"}}]) {
    const {route,calls}=setup({realGuards:true,recoveryStatus:"reserved",...options});
    const response=await route.GET(new NextRequest(
      `http://localhost/api/question-followup?request_id=${requestId}`));
    assert.equal(response.status,403);
    assert.equal(calls.admin,0);
    assert.equal(calls.rpc.length,0);
    assert.equal(calls.generation.length,0);
  }
});

test("configuration failure is recorded before returning and never dispatches", async () => {
  const { calls, route } = setup({ configFailure: true });
  const response = await post(route.POST);
  assert.equal(response.status, 503);
  assert.deepEqual(calls.rpc.map(call => call.name), [
    "begin_question_followup", "finish_question_followup",
  ]);
  assert.equal(calls.rpc.at(-1).args.p_outcome, "failed");
  assert.equal(calls.generation.length, 0);
});

test("stale answer revisions are rejected before any generation request is reserved", async () => {
  const { calls, route } = setup({ answer: { ...savedAnswer, updated_at: "2026-10-08T11:00:01.000Z" } });
  const response = await post(route.POST);
  assert.equal(response.status, 409);
  assert.equal(calls.rpc.length, 0);
  assert.equal(calls.generation.length, 0);
});

test("POST and GET deny disabled generation, missing profiles and inactive or administrator accounts", async () => {
  const {NextRequest}=require("next/server");
  const participant={participant_code:"P01",account_type:"P",role:"participant",status:"active"};
  for(const options of [
    {env:{}},
    {env:{OPENAI_QUESTION_FOLLOWUP_ENABLED:"false"}},
    {env:{OPENAI_QUESTION_FOLLOWUP_ENABLED:"TRUE"}},
    {profile:{...participant,status:"deactivated"}},
    {profile:{...participant,role:"admin"}},
    {profile:null},
  ]) {
    const {route,calls}=setup(options);
    assert.equal((await post(route.POST)).status,403);
    assert.equal((await route.GET(new NextRequest(
      `http://localhost/api/question-followup?request_id=${requestId}`))).status,403);
    assert.equal(calls.admin,0);
    assert.equal(calls.rpc.length,0);
    assert.equal(calls.generation.length,0);
    assert.ok(calls.reads.every(table=>table==="profiles"));
  }
});

test("GET recovery uses the internal row ID, never dispatches AI, and preserves raced terminal results", async () => {
  const {NextRequest}=require("next/server");
  for(const [status,outcome,finishOutcome] of [
    ["reserved","failed",undefined],
    ["dispatch_started","outcome_unknown",undefined],
    ["reserved","generated","generated"],
  ]) {
    const {route,calls}=setup({recoveryStatus:status,finishOutcome});
    const response=await route.GET(new NextRequest(
      `http://localhost/api/question-followup?request_id=${requestId}`));
    assert.equal(response.status,200);
    assert.equal((await response.json()).outcome,outcome);
    assert.equal(calls.rpc.length,1);
    assert.equal(calls.rpc[0].name,"finish_question_followup");
    assert.equal(calls.rpc[0].args.p_request_id,dbRequestId);
    assert.equal(calls.generation.length,0);
  }
  const raced=setup({recoveryStatus:"reserved",finishOutcome:"dispatch_started"});
  const pending=await raced.route.GET(new NextRequest(
    `http://localhost/api/question-followup?request_id=${requestId}`));
  assert.equal(pending.status,202);
  assert.deepEqual(await pending.json(),{outcome:"pending",request_id:requestId});
  assert.equal(raced.calls.generation.length,0);
});

test("GET returns pending and saved outcomes without a provider or mutation", async () => {
  const {NextRequest}=require("next/server");
  for(const status of ["reserved","dispatch_started","generated","no_followup","failed","outcome_unknown"]) {
    const {route,calls}=setup({recoveryStatus:status,recoveryAge:100});
    const response=await route.GET(new NextRequest(
      `http://localhost/api/question-followup?request_id=${requestId}`));
    const pending=["reserved","dispatch_started"].includes(status);
    assert.equal(response.status,pending?202:200);
    assert.equal((await response.json()).outcome,pending?"pending":status);
    assert.equal(calls.rpc.length,0);
    assert.equal(calls.generation.length,0);
  }
});

test("disabled generation requires no profile lookup and profile lookup errors remain explicit", async () => {
  const {readQuestionFollowupAccess}=loader()("src/lib/question-generation/followup-access.ts");
  const caller={from:()=>({select(){return this;},eq(){return this;},
    maybeSingle:async()=>({data:{participant_code:"T01",account_type:"T",role:"participant",status:"active"},error:null})})};
  assert.deepEqual(await readQuestionFollowupAccess({from(){throw new Error("Disabled");}},owner,{}),
    {enabled:false});
  assert.deepEqual(await readQuestionFollowupAccess(caller,owner,{OPENAI_QUESTION_FOLLOWUP_ENABLED:"true"}),
    {enabled:true});
  await assert.rejects(readQuestionFollowupAccess({
    from:()=>({select(){return this;},eq(){return this;},
      maybeSingle:async()=>({data:null,error:{code:"DB"}})})},
    owner,{OPENAI_QUESTION_FOLLOWUP_ENABLED:"true"}),
  error=>error.code==="FOLLOWUP-DB");
});

test("follow-up model defaults to the existing initial-generation model without enabling calls", () => {
  const {questionFollowupConfig}=loader()("src/lib/ai/server/question-followup-config.ts");
  const env={OPENAI_API_KEY:"test-only",OPENAI_QUESTION_GENERATION_MODEL:"test-initial-model"};
  assert.throws(()=>questionFollowupConfig(env),error=>error.code==="FOLLOWUP-CONFIG");
  assert.deepEqual(questionFollowupConfig({...env,OPENAI_QUESTION_FOLLOWUP_ENABLED:"true"}),
    {apiKey:"test-only",model:"test-initial-model"});
});
