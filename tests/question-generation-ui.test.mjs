import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { URL } from "node:url";
import ts from "typescript";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import console from "node:console";

const require = createRequire(import.meta.url);
const { setTimeout, AbortController, Response, structuredClone } = globalThis;
function loader(overrides = {}) {
  const cache = new Map();
  function load(path) {
    let url = path instanceof URL ? path : new URL(`../${path}`, import.meta.url);
    if (!existsSync(url) && url.pathname.endsWith(".ts")) url = new URL(url.href + "x");
    if (cache.has(url.href)) return cache.get(url.href);
    const compiled = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    const module = { exports: {} };
    runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
      name => Object.hasOwn(overrides, name) ? overrides[name] : name === "server-only" ? {} :
        name.startsWith("@/") ? load(`src/${name.slice(2)}.ts`) :
          name.startsWith(".") ? load(new URL(`${name}.ts`, url)) : require(name), module, module.exports);
    cache.set(url.href, module.exports);
    return module.exports;
  }
  return load;
}
const sessionId = "20000000-0000-4000-8000-000000000001";
const requestId = "40000000-0000-4000-8000-000000000001";
const imageId = "60000000-0000-4000-8000-000000000001";
const valid = { primary_category_id: "ux_ui", subcategory_id: "web_design", other_category_text: null,
  stage_id: "idea_concept", additional_context: "TEST saved synthetic context", context_ids: ["visual_form"] };
function view(state = "editable", n = 3) {
  return { session_id: sessionId, state, requested_question_count: n, failed_request_id: null,
    question_actions:{ready:false,reserve_count:0,
      reserve_count_by_question:Object.fromEntries((state==="completed"?Array.from({length:n},(_,i)=>
        `50000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`):[]).map(id=>[id,0]))},
    answer_editable:state==="completed",followup_enabled:false,readability_improved:true,
    questions: state === "completed" ? Array.from({length:n}, (_,i)=>({
      id: `50000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`, slot_index:i+1, question_text:`TEST question ${i+1}`,
      status:"unprocessed",regeneration_index:0,
      targets:[{image_id:imageId,x:0.1+i*0.1,y:0.2,width:0.15,height:0.12,sort_order:0}],
      answer:{original_answer:"",refined_answer:null,refinement_used:false,
        current_answer_version:"original",updated_at:null},
      followup_question:null,last_followup_request:null,
    })) : [],
    images:state==="completed"?[{id:imageId,sort_order:0,width:1200,height:800,
      signed_url:"https://private-test.supabase.co/storage/v1/object/sign/why-box-images/test"}]:[] };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function briefingBody(current="Synthetic design briefing",revision=0) {
  return {
    source:{
      session_id:sessionId,participant_id:"70000000-0000-4000-8000-000000000001",
      request_id:"70000000-0000-4000-8000-000000000002",
      source_text:"Synthetic design briefing",model_id:"WHY-BOX-LOCAL-MOCK",
      prompt_version:"session-design-briefing-v1.0",schema_version:"session-design-briefing-v1.0",
      generated_at:"2026-01-01T00:00:00.000Z",
    },
    current,revision,edited_at:revision? "2026-01-02T00:00:00.000Z":null,
  };
}
const load = loader();
const contract = load("src/lib/question-generation/view-contract.ts");
const { GenerationController, GENERATION_MAX_READS, GENERATION_POLL_MS, GENERATION_REQUEST_MS, sendGeneration, readGeneration } =
  load("src/lib/question-generation/controller.ts");
const settle = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r=>{resolve=r;}); return {promise,resolve}; };

function participantView() {
  const result=view("completed");
  result.followup_enabled=true;
  result.readability_improved=true;
  result.questions[0].status="answered";
  result.questions[0].answer.original_answer="TEST saved reflection";
  result.questions[0].answer.updated_at="2026-10-08T11:00:00.000Z";
  return result;
}

function generatedFollowup(result) {
  const next=structuredClone(result);
  next.questions[0].followup_question={
    id:"80000000-0000-4000-8000-000000000001",question_text:"TEST follow-up perspective?",
    status:"unprocessed",answer:{original_answer:"",refined_answer:null,refinement_used:false,
      current_answer_version:"original",updated_at:null},
  };
  return next;
}

test("generation-disabled participant keeps answer readability without exposing the follow-up button",async t=>{
  const ui=await mountResult(t,view("completed"));
  assert.equal(ui.host.querySelector(".question-followup-button"),null);
  assert.ok(ui.host.querySelector(".question-readability"));
  assert.ok(ui.host.querySelector(".question-refine-button"));
  assert.equal(ui.host.querySelector("#question-answer-text").disabled,false);
});

test("participant button waits for the latest autosave and prevents duplicate requests before locking",async t=>{
  const initial=participantView(),save=deferred(),generation=deferred(),requests=[];
  const ui=await mountResult(t,initial,async(url,options)=>{
    requests.push({url,body:JSON.parse(options.body)});
    if(url==="/api/question-answer") {
      await save.promise;
      return json({success:true,answer_version:"original",updated_at:"2026-10-08T11:00:01.000Z"});
    }
    await generation.promise;
    const next=generatedFollowup(initial);
    next.questions[0].answer.original_answer="TEST latest reflection";
    next.questions[0].answer.updated_at="2026-10-08T11:00:01.000Z";
    return json({outcome:"generated",view:next,activity_recorded:true});
  });
  const textarea=ui.host.querySelector("#question-answer-text");
  await act(async()=>{
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype,"value")
      .set.call(textarea,"TEST latest reflection");
    textarea.dispatchEvent(new ui.dom.window.Event("input",{bubbles:true}));
    await settle();
    ui.host.querySelector(".question-followup-button").click();
    await settle();
  });
  assert.deepEqual(requests.map(r=>r.url),["/api/question-answer"]);
  assert.equal(textarea.disabled,true);
  assert.equal(ui.host.querySelector(".question-followup-button").disabled,true);
  await act(async()=>{save.resolve();await settle();});
  assert.equal(requests.length,2);
  assert.equal(requests[1].body.expected_updated_at,"2026-10-08T11:00:01.000Z");
  await act(async()=>{ui.host.querySelector(".question-followup-button").click();await settle();});
  assert.equal(requests.length,2);
  await act(async()=>{generation.resolve();await settle();});
  const locked=ui.host.querySelector("#question-answer-text");
  assert.equal(locked.readOnly,true);
  assert.equal(locked.disabled,false);
  assert.equal(locked.value,"TEST latest reflection");
  assert.equal(ui.host.querySelector(".question-refine-button").disabled,true);
  assert.ok(ui.host.querySelector("#question-followup-answer-text"));
  assert.equal(requests.length,2);
});

test("a saved follow-up restores read-only original and editable optional child with generation disabled",async t=>{
  const result=generatedFollowup(participantView());
  result.followup_enabled=false;
  result.questions[0].answer.refinement_used=true;
  result.questions[0].answer.refined_answer="TEST selected refined reflection";
  result.questions[0].answer.current_answer_version="refined";
  result.questions[0].followup_question.answer.original_answer="TEST restored child";
  result.questions[0].followup_question.answer.updated_at="2026-10-08T11:00:01.000Z";
  const ui=await mountResult(t,result,async()=>{throw new Error("No writes expected");});
  assert.equal(ui.host.querySelector("#question-answer-text").readOnly,true);
  assert.equal(ui.host.querySelector("#question-answer-text").value,"TEST selected refined reflection");
  assert.equal(ui.host.querySelector("#question-followup-answer-text").value,"TEST restored child");
  assert.equal(ui.host.querySelector("#question-followup-answer-text").disabled,false);
  assert.equal(ui.host.querySelector(".question-answer-version-button"),null);
  assert.equal(ui.host.querySelector(".question-followup-button"),null);
  assert.ok(ui.host.querySelector(".question-readability"));
});

test("participant no-follow-up blocks identical answers and enables the button after an edit",async t=>{
  const initial=participantView(),next=structuredClone(initial);
  next.questions[0].last_followup_request={
    request_id:requestId,status:"no_followup",answer_snapshot:initial.questions[0].answer.original_answer,
    created_at:"2026-10-22T00:00:00.000Z",prompt_version:"question-followup-v1.0",
    model_id:"test-model",input_tokens:12,output_tokens:8,
  };
  let calls=0;
  const ui=await mountResult(t,initial,async()=>{calls++;return json({outcome:"no_followup",view:next,activity_recorded:true});});
  await act(async()=>{ui.host.querySelector(".question-followup-button").click();await settle();});
  assert.equal(calls,1);
  assert.equal(ui.host.querySelector(".question-followup-button").disabled,true);
  assert.equal(ui.host.querySelector("#question-answer-text").readOnly,false);
  assert.match(ui.host.textContent,/현재 답변에서 추가로 탐색할 질문이 없습니다/);
  assert.match(ui.host.querySelector(".toast-box[role='status']").textContent,
    /현재 답변에서 추가로 탐색할 질문이 없습니다/);
  assert.equal(ui.host.querySelector(".question-followup-notice"),null);
  await act(async()=>{
    const textarea=ui.host.querySelector("#question-answer-text");
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype,"value")
      .set.call(textarea,"TEST changed reflection");
    textarea.dispatchEvent(new ui.dom.window.Event("input",{bubbles:true}));
    await settle();
  });
  assert.equal(ui.host.querySelector(".question-followup-button").disabled,false);
  assert.equal(calls,1);
});

test("participant empty answers cannot request a follow-up",async t=>{
  const result=participantView();
  result.questions[0].answer.original_answer=" \n ";
  const ui=await mountResult(t,result,async()=>{throw new Error("No request allowed");});
  assert.equal(ui.host.querySelector(".question-followup-button").disabled,true);
});

test("follow-up answers flush under their own ID before navigating away",async t=>{
  const initial=generatedFollowup(participantView()),pending=deferred(),calls=[];
  const childId=initial.questions[0].followup_question.id;
  const ui=await mountResult(t,initial,async(url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});
    await pending.promise;
    return json({success:true,answer_version:"original",updated_at:"2026-10-22T11:00:00.000Z"});
  });
  await act(async()=>{
    const textarea=ui.host.querySelector("#question-followup-answer-text");
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype,"value")
      .set.call(textarea,"TEST optional child draft");
    textarea.dispatchEvent(new ui.dom.window.Event("input",{bubbles:true}));
    await settle();
    ui.host.querySelector('[aria-label="질문 2 선택"]').click();
    await settle();
  });
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,"/api/question-answer");
  assert.equal(calls[0].body.question_id,childId);
  assert.equal(calls[0].body.answer_text,"TEST optional child draft");
  assert.match(ui.host.querySelector(".question-panel-count").textContent,/질문 1/);
  await act(async()=>{pending.resolve();await settle();});
  assert.match(ui.host.querySelector(".question-panel-count").textContent,/질문 2/);
});

test("failed recovery restores editing and unknown recovery suppresses an identical new request",async t=>{
  for(const outcome of ["failed","outcome_unknown"]) {
    const initial=participantView(),next=structuredClone(initial),calls=[];
    initial.questions[0].last_followup_request={
      request_id:requestId,status:"dispatch_started",answer_snapshot:initial.questions[0].answer.original_answer,
      created_at:"2026-10-22T00:00:00.000Z",prompt_version:"question-followup-v1.0",
      model_id:"test-model",input_tokens:null,output_tokens:null,
    };
    next.questions[0].last_followup_request={...initial.questions[0].last_followup_request,status:outcome};
    const ui=await mountResult(t,initial,async(url,options)=>{
      calls.push({url,method:options.method});
      return json({outcome,view:next,activity_recorded:true});
    });
    await act(async()=>{ui.host.querySelector(".question-followup-button").click();await settle();});
    assert.deepEqual(calls,[{url:`/api/question-followup?request_id=${requestId}`,method:"GET"}]);
    assert.equal(ui.host.querySelector("#question-answer-text").readOnly,false);
    assert.equal(ui.host.querySelector("#question-answer-text").disabled,false);
    assert.equal(ui.host.querySelector(".question-followup-button").disabled,outcome==="outcome_unknown");
    await ui.close();
  }
});

test("participant readability stays scoped to question results while other screen typography stays global",()=>{
  const css=readFileSync("src/app/globals.css","utf8");
  assert.match(css,/body \{[^}]*-webkit-font-smoothing: antialiased;/);
  assert.match(css,/\.question-readability \{[^}]*--font-family-base: -apple-system,[^}]*font-family:var\(--font-family-base\);[^}]*-webkit-font-smoothing:auto;/);
  const resultFontRule=css.match(/\.question-readability \{[^}]*\}/)?.[0];
  assert.ok(resultFontRule);
  assert.doesNotMatch(resultFontRule,/Pretendard/);
  assert.match(css,/\.question-readability \.question-answer-textarea::placeholder \{ color:var\(--color-text-secondary\)/);
  assert.match(css,/\.question-answer-textarea \{[^}]*font:inherit;/);
  assert.match(css,/\.question-readability \.question-answer-textarea\.has-answer-diff \{ -webkit-text-fill-color:transparent; \}/);
  assert.match(css,/\.question-readability \.question-answer-diff \{[^}]*font-weight:var\(--font-weight-regular\)/);
  assert.match(css,/\.question-readability \.question-answer-textarea::placeholder \{[^}]*font-weight:var\(--font-weight-regular\)/);
  assert.match(css,/\.question-readability \.question-answer-textarea\.question-followup-answer \{ background:#fff; color:#222;/);
});

test("follow-up input has no visible thought label and retains its accessible name",async t=>{
  const ui=await mountResult(t,generatedFollowup(participantView()),async()=>{
    throw new Error("No network request expected");
  });
  assert.equal(ui.host.querySelector(".question-followup-answer-label"),null);
  assert.equal(ui.host.querySelector(".question-followup label"),null);
  assert.equal(ui.host.querySelector("#question-followup-answer-text").getAttribute("aria-label"),
    "후속 질문에 대한 나의 생각");
});

test("strict saved view contract requires contiguous ordered N slots and rejects internal metadata", () => {
  for(const n of [1,3,5]) assert.equal(contract.generationViewSchema.safeParse(view("completed",n)).success,true);
  for(const invalid of [
    {...view(), requested_question_count:0}, {...view(), requested_question_count:6},
    {...view("completed"), questions:view("completed").questions.slice(1)},
    {...view("completed"), questions:[...view("completed").questions].reverse()},
    {...view("completed"),images:[]},
    {...view("completed"),questions:view("completed").questions.map((q,i)=>i===0?{...q,targets:[{...q.targets[0],image_id:"60000000-0000-4000-8000-000000000099"}]}:q)},
    {...view("completed"),questions:view("completed").questions.map((q,i)=>i===0?{...q,targets:[{...q.targets[0],x:null}]}:q)},
    {...view(), model:"hidden"}, {...view("completed"),questions:view("completed").questions.map(q=>({...q,candidate_rank:1}))},
  ]) assert.equal(contract.generationViewSchema.safeParse(invalid).success,false);
});

test("request sends only IDs and accepts exact 200/202 contracts; GET never POSTs", async (t) => {
  const calls = [];
  t.mock.method(globalThis,"fetch",async (url,opts)=>{
    calls.push({url,opts});
    if(opts.method==="POST") return json({request_id:requestId,attempt_id:randomUUID(),status:"running",retry_same_request:true},202);
    return json(view("running"));
  });
  await sendGeneration(sessionId,requestId,new AbortController().signal);
  await readGeneration(sessionId,new AbortController().signal);
  assert.deepEqual(JSON.parse(calls[0].opts.body),{session_id:sessionId,request_id:requestId});
  assert.equal(calls[0].opts.method,"POST"); assert.equal(calls[1].opts.method,undefined);
  assert.equal(calls[0].opts.cache,"no-store"); assert.equal(calls[1].opts.cache,"no-store");
});

test("double start, rerender-style attach and Strict Mode reuse have one POST with stable request ID", async () => {
  const pending = deferred(), calls = [], states=[];
  const controller = new GenerationController(view(),()=>true,s=>states.push(s),async (...args)=>{
    calls.push(args); await pending.promise; return {status:"running"};
  },async()=>view("running"));
  controller.attach();
  const first = controller.start(); void controller.start(); controller.detach(); controller.attach();
  await settle(); assert.equal(calls.length,1); assert.match(calls[0][1],/^[0-9a-f-]{36}$/);
  pending.resolve(); await first;
  assert.equal(states.at(-1).view.state,"running"); assert.equal(calls.length,1);
  controller.detach(); await settle();
});

test("202 uses bounded GET polling only and stops in locked recovery after budget", async (t) => {
  t.mock.timers.enable({apis:["setTimeout"]});
  let posts=0,reads=0; const states=[];
  const controller = new GenerationController(view(),()=>true,s=>states.push(s),async()=>{
    posts++; return {status:"running"};
  },async()=>{reads++; return view("running");});
  controller.attach(); await controller.start();
  for(let i=0;i<GENERATION_MAX_READS+5;i++) {t.mock.timers.tick(GENERATION_POLL_MS);await settle();}
  assert.equal(posts,1); assert.equal(reads,GENERATION_MAX_READS); assert.equal(states.at(-1).view.state,"recovery");
  await controller.start(); assert.equal(posts,1); controller.detach(); await settle();
});

test("re-entry running polls without POST and safe failed attempt unlocks", async (t) => {
  t.mock.timers.enable({apis:["setTimeout"]});
  const states=[]; let posts=0;
  const controller = new GenerationController(view("running"),()=>true,s=>states.push(s),
    async()=>{posts++;},async()=>({...view(),failed_request_id:requestId}));
  controller.attach();t.mock.timers.tick(GENERATION_POLL_MS);await settle();
  assert.equal(posts,0);assert.equal(states.at(-1).view.state,"editable");
  controller.detach();await settle();
});

test("ambiguous response cannot unlock on an empty/no-failed-attempt read; staged recovery never POSTs", async () => {
  let posts=0;const states=[];
  const controller = new GenerationController(view(),()=>true,s=>states.push(s),async()=>{posts++;throw new Error("PRIVATE");},
    async()=>view());
  controller.attach();await controller.start();assert.equal(states.at(-1).view.state,"recovery");
  assert.doesNotMatch(states.at(-1).message,/PRIVATE/);await controller.start();assert.equal(posts,1);
  controller.detach();await settle();
  const recovered = new GenerationController(view("recovery"),()=>true,()=>{},async()=>{posts++;},async()=>view("recovery"));
  recovered.attach();await recovered.check();await recovered.start();assert.equal(posts,1);recovered.detach();await settle();
});

test("API failure maps safe text and confirmed same-request failure restores editing", async (t) => {
  let sent;const states=[];
  t.mock.method(globalThis,"fetch",async (_url,opts)=>{
    sent=JSON.parse(opts.body).request_id;return json({errorCode:"QGEN-API",message:"PRIVATE ERROR"},502);
  });
  const controller = new GenerationController(view(),()=>true,s=>states.push(s),sendGeneration,
    async()=>({...view(),failed_request_id:sent}));
  controller.attach();await controller.start();
  assert.equal(states.at(-1).view.state,"editable");assert.match(states.at(-1).message,/질문 생성 요청/);
  assert.doesNotMatch(states.at(-1).message,/PRIVATE/);controller.detach();await settle();
});

test("completed re-entry and ineligible drafts do not issue generation", async () => {
  let posts=0;
  for(const [initial,ready] of [[view("completed"),true],[view("recovery"),true],[view(),false]]) {
    const c=new GenerationController(initial,()=>ready,()=>{},async()=>{posts++;},async()=>initial);
    c.attach();await c.start();c.detach();await settle();
  }
  assert.equal(posts,0);
});

test("read-only catalog path returns ordered public questions, failed unlock and running/staged locks", async () => {
  const {readGenerationView}=load("src/lib/question-generation/read.ts");
  const owner=randomUUID(); const calls=[];
  function caller(status,attempt,questions=view("completed").questions,signedError=false) {
    const values={sessions:{status,requested_question_count:3},question_generation_attempts:attempt?[attempt]:[],
      questions:questions.map(question=>({id:question.id,slot_index:question.slot_index,question_text:question.question_text,
        status:question.status,regeneration_index:question.regeneration_index})),
      question_followup_requests:[],
      session_images:[{id:imageId,storage_path:`${owner}/${sessionId}/test.png`,sort_order:0,width:1200,height:800}],
      question_targets:questions.flatMap(q=>q.targets.map(target=>({question_id:q.id,...target}))),
      answers:questions.length?[{question_id:questions[0].id,original_answer:"TEST saved thought",refined_answer:null,
        refinement_used:false,current_answer_version:"original",updated_at:"2026-10-08T11:00:00.123456+00:00"}]:[]};
    return {rpc:async()=>({data:{ready:false,reserve_count:0,
      reserve_count_by_question:Object.fromEntries(questions.map(question=>[question.id,0]))},error:null}),from(table){
      let rows=values[table];
      const q={select(columns){calls.push({table,columns});
          if(table==="questions"&&columns.includes("parent_question_id"))rows=[];
          return q;},eq(){return q;},in(){return q;},order(){return q;},limit(){return q;},
        maybeSingle:async()=>({data:rows,error:null}),then(resolve){return Promise.resolve({data:rows,error:null}).then(resolve);}};
      return q;
    },storage:{from(bucket){assert.equal(bucket,"why-box-images");return {createSignedUrl:async(path,seconds)=>{
      assert.equal(seconds,180);assert.equal(path,`${owner}/${sessionId}/test.png`);
      return {data:signedError?null:{signedUrl:"https://private-test.supabase.co/storage/v1/object/sign/why-box-images/test"},
        error:signedError?{code:"STORAGE"}:null};
    }};}}};
  }
  const result=await readGenerationView(caller("in_progress",null),owner,sessionId);
  assert.equal(result.state,"completed");assert.equal(result.questions.length,3);
  assert.equal(result.images[0].signed_url.startsWith("https://private-test.supabase.co/"),true);
  assert.deepEqual(result.questions[0].targets,[{image_id:imageId,x:0.1,y:0.2,width:0.15,height:0.12,sort_order:0}]);
  assert.equal(result.questions[0].answer.original_answer,"TEST saved thought");
  assert.equal(result.questions[0].answer.updated_at,"2026-10-08T11:00:00.123456+00:00");
  assert.equal(result.answer_editable,true);
  assert.equal(result.followup_enabled,false);
  assert.equal(result.readability_improved,true);
  assert.equal(calls.some(call=>call.table==="question_followup_requests"),false);
  assert.doesNotMatch(JSON.stringify(result),/storage_path|question_id|service_role/);
  await assert.rejects(readGenerationView(caller("in_progress",null,view("completed").questions,true),owner,sessionId),
    error=>error.code==="QGEN-IMAGE");
  for(const [status,attempt,state] of [
    ["draft",null,"editable"],["question_generation",null,"recovery"],
    ["question_generation",{status:"failed",generated_at:null,request_id:requestId},"editable"],
    ["draft",{status:"running",generated_at:null,request_id:requestId},"running"],
    ["draft",{status:"running",generated_at:"2026-10-08T00:00:00Z",request_id:requestId},"recovery"],
  ]) assert.equal((await readGenerationView(caller(status,attempt,[]),owner,sessionId)).state,state);
  assert.ok(calls.filter(c=>c.table==="questions").some(c=>c.columns==="id,slot_index,question_text,status,regeneration_index"));
  await assert.rejects(readGenerationView(caller("in_progress",null,[]),owner,sessionId),e=>e.code==="QGEN-RECOVERY");
  await assert.rejects(readGenerationView(caller("unknown",null,[]),owner,sessionId),e=>e.code==="QGEN-DB");
});

test("saved follow-up and parent lock restore through the real read contract even when new generation is off",async()=>{
  const owner=randomUUID(),childId=randomUUID();
  const base=view("completed"),parent=base.questions[0];
  const request={request_id:requestId,parent_question_id:parent.id,status:"generated",
    answer_snapshot:"Saved parent answer",created_at:"2026-10-22T00:00:00.000Z",
    prompt_version:"question-followup-v1.0",model_id:"test-model",input_tokens:12,output_tokens:8};
  const rows={
    sessions:{status:"in_progress",requested_question_count:3},
    question_generation_attempts:[],
    session_images:[{id:imageId,storage_path:`${owner}/${sessionId}/test.png`,sort_order:0,width:1200,height:800}],
    question_targets:base.questions.map(q=>({question_id:q.id,...q.targets[0]})),
    question_followup_requests:[request],
    answers:[
      {question_id:parent.id,original_answer:"Saved parent answer",refined_answer:null,refinement_used:false,
        current_answer_version:"original",updated_at:"2026-10-08T11:00:00.000Z"},
      {question_id:childId,original_answer:"Saved child answer",refined_answer:null,refinement_used:false,
        current_answer_version:"original",updated_at:"2026-10-08T11:00:01.000Z"},
    ],
  };
  const caller={
    rpc:async()=>({data:base.question_actions,error:null}),
    from(table) {
      let data=rows[table];
      const q={select(columns){
        if(table==="questions")data=columns.includes("parent_question_id")?
          [{id:childId,parent_question_id:parent.id,question_text:"A follow-up?",status:"answered"}]:
          base.questions.map(({id,slot_index,question_text,status,regeneration_index})=>
            ({id,slot_index,question_text,status,regeneration_index}));
        return q;
      },eq(column,value){
        if(table==="question_followup_requests")data=data.filter(row=>column!=="participant_id"&&column!=="session_id"?
          row[column]===value:true);
        return q;
      },in(){return q;},order(){return q;},limit(n){if(Array.isArray(data))data=data.slice(0,n);return q;},
      maybeSingle:async()=>({data,error:null}),
      then(resolve){return Promise.resolve({data,error:null}).then(resolve);}};
      return q;
    },
    storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:base.images[0].signed_url},error:null})})},
  };
  const {readGenerationView}=loader({
    "./followup-access":{readQuestionFollowupAccess:async()=>({enabled:false})},
  })("src/lib/question-generation/read.ts");
  const result=await readGenerationView(caller,owner,sessionId);
  assert.equal(result.followup_enabled,false);
  assert.equal(result.readability_improved,true);
  assert.equal(result.questions.length,3);
  assert.equal(result.questions[0].followup_question.id,childId);
  assert.equal(result.questions[0].followup_question.answer.original_answer,"Saved child answer");
  assert.equal(result.questions[0].last_followup_request.status,"generated");
  assert.equal(contract.generationViewSchema.safeParse(result).success,true);
});

test("large and skewed request history restores only each active parent's latest state without truncating other parents",async()=>{
  const owner=randomUUID(),base=participantView(),parent=base.questions[0],childId=randomUUID();
  const request=(question,index,status="no_followup")=>({
    id:`90000000-0000-4000-8000-${String(index).padStart(12,"0")}`,session_id:sessionId,participant_id:owner,
    request_id:randomUUID(),parent_question_id:question.id,status,answer_snapshot:`Saved answer ${index}`,
    created_at:new Date(Date.UTC(2026,9,22,0,0,index)).toISOString(),
    prompt_version:"question-followup-v1.0",model_id:"offline",input_tokens:12,output_tokens:8,
  });
  const history=Array.from({length:1500},(_,i)=>request(parent,i));
  const latest=request(parent,1501,"generated");
  const second=request(base.questions[1],1,"no_followup");
  const third=request(base.questions[2],2,"outcome_unknown");
  history.push(latest,second,third,request({...parent,id:randomUUID()},2000,"failed"));
  const original=JSON.stringify(history);
  const queries=[];
  let failHistory=false;
  const rows={
    sessions:{status:"in_progress",requested_question_count:3},
    profiles:{role:"participant",status:"active"},
    question_generation_attempts:[],
    question_followup_requests:history,
    session_images:[{id:imageId,storage_path:`${owner}/${sessionId}/test.png`,sort_order:0,width:1200,height:800}],
    question_targets:base.questions.map(q=>({question_id:q.id,...q.targets[0]})),
    answers:[{question_id:childId,original_answer:"Restored independent child answer",refined_answer:null,
      refinement_used:false,current_answer_version:"original",updated_at:"2026-10-22T01:00:00.000Z"}],
  };
  const caller={
    rpc:async()=>({data:base.question_actions,error:null}),
    from(table){
      let data=rows[table],columns,limit;
      const filters=[],orders=[];
      const query={
        select(value){
          columns=value;
          if(table==="questions")data=value.includes("parent_question_id")?
            [{id:childId,parent_question_id:parent.id,question_text:"Saved child?",status:"answered"}]:
            base.questions.map(({id,slot_index,question_text,status,regeneration_index})=>
              ({id,slot_index,question_text,status,regeneration_index}));
          return query;
        },
        eq(column,value){filters.push([column,value]);return query;},
        in(){return query;},
        order(column,options){orders.push([column,options]);return query;},
        limit(value){limit=value;return query;},
        maybeSingle:async()=>({data,error:null}),
        then(resolve){
          if(table==="question_followup_requests"){
            assert.equal(limit,1);
            assert.deepEqual(orders,[["created_at",{ascending:false}],["id",{ascending:false}]]);
            assert.ok(filters.some(([k,v])=>k==="session_id"&&v===sessionId));
            assert.ok(filters.some(([k,v])=>k==="participant_id"&&v===owner));
            data=data.filter(row=>filters.every(([k,v])=>row[k]===v)).sort((a,b)=>
              b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id)).slice(0,limit)
              .map(row=>Object.fromEntries(columns.split(",").map(k=>[k,row[k]])));
            queries.push(data);
          }
          return Promise.resolve({data,error:failHistory&&table==="question_followup_requests"?{code:"DB"}:null}).then(resolve);
        },
      };
      return query;
    },
    storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:base.images[0].signed_url},error:null})})},
  };
  const {readGenerationView}=loader({
    "./followup-access":{readQuestionFollowupAccess:(client,userId)=>
      load("src/lib/question-generation/followup-access.ts").readQuestionFollowupAccess(
        client,userId,{OPENAI_QUESTION_FOLLOWUP_ENABLED:"true"})},
  })("src/lib/question-generation/read.ts");
  const result=await readGenerationView(caller,owner,sessionId);
  assert.equal(result.followup_enabled,true);
  assert.equal(result.readability_improved,true);
  assert.deepEqual(result.questions.map(q=>q.last_followup_request.request_id),
    [latest.request_id,second.request_id,third.request_id]);
  assert.equal(result.questions[0].followup_question.answer.original_answer,"Restored independent child answer");
  assert.equal(queries.length,3);
  assert.equal(queries.flat().length,3);
  assert.equal(contract.generationViewSchema.safeParse(result).success,true);
  assert.doesNotMatch(JSON.stringify(result),/participant_id|parent_question_id/);
  assert.equal(JSON.stringify(history),original);
  failHistory=true;
  await assert.rejects(readGenerationView(caller,owner,sessionId),error=>error.code==="QGEN-DB");
});

async function mount(t, {initial=view(),input=valid,imageCount=1,available=true,saveResult,
  readResult,postResult,countSaveResult,draftResult,strict=true,sessionStatus="draft"}={}) {
  const dom=new JSDOM("<!doctype html><div id='root'></div>",{url:"http://localhost/sessions/"+sessionId});
  const originals={};
  for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,Element:dom.window.Element,
    HTMLAnchorElement:dom.window.HTMLAnchorElement,IS_REACT_ACT_ENVIRONMENT:true})) {
    originals[name]=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
  }
  dom.window.localStorage.setItem(`why-box:session-step:${sessionId}`,"3");
  const {createRoot}=await import("react-dom/client");
  const calls=[],saves=[],countSaves=[];let current=structuredClone(initial),latestRequest;
  t.mock.method(globalThis,"fetch",async (url,opts={})=>{
    calls.push({url,opts});
    if(url==="/api/context-draft") {
      const body=JSON.parse(opts.body);return draftResult?draftResult(body):json({request_id:body.request_id,skipped:true});
    }
    if(url==="/api/question-generation"&&opts.method==="POST") {
      latestRequest=JSON.parse(opts.body).request_id;
      if(postResult) return postResult(latestRequest);
      current=view("completed",current.requested_question_count);
      return json({request_id:latestRequest,attempt_id:randomUUID(),status:"completed",question_ids:current.questions.map(q=>q.id)});
    }
    if(String(url).startsWith("/api/question-generation?")) return json(readResult?readResult(latestRequest):current);
    throw new Error("UNMOCKED NETWORK BLOCKED");
  });
  const MockImages=({editable,onImageCountChange,onImageRevisionChange,onAvailabilityChange})=>{
    React.useEffect(()=>{onImageCountChange(imageCount);onImageRevisionChange("TEST");onAvailabilityChange(available);},
      [onImageCountChange,onImageRevisionChange,onAvailabilityChange]);
    return React.createElement("button",{disabled:!editable,"data-testid":"image-edit"},"TEST image control");
  };
  const components=loader({
    "next/link":{default:({children,...props})=>React.createElement("a",props,children)},
    "next/navigation":{useRouter:()=>({push(){}})},
    "@/app/toast":{Toast:({message,error})=>React.createElement("p",{role:error?"alert":"status"},message)},
    "./image-uploader":{ImageUploader:MockImages},
    "./context-actions":{
      saveSessionContext:async (_id,value)=>{saves.push(value);return saveResult?saveResult(value):{success:true,changed:true,activityRecorded:true};},
      saveQuestionCount:async (_id,value)=>{
        countSaves.push(value);
        const result=countSaveResult?await countSaveResult(value):{success:true,changed:true,activityRecorded:true};
        if(result.success) current={...current,requested_question_count:value};
        return result;
      },
    },
  });
  const {SessionWizard}=components("src/app/(participant)/sessions/[sessionId]/session-wizard.tsx");
  const host=dom.window.document.getElementById("root");const root=createRoot(host);
  const render=()=>root.render(strict?React.createElement(React.StrictMode,null,
    React.createElement(SessionWizard,{sessionId,initial:input,initialGeneration:initial,sessionStatus})):
    React.createElement(SessionWizard,{sessionId,initial:input,initialGeneration:initial,sessionStatus}));
  await act(async()=>{render();await settle();});
  t.after(async()=>{
    await act(async()=>{root.unmount();await settle();});dom.window.close();
    for(const [name,descriptor] of Object.entries(originals)) {
      if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
    }
  });
  const button=(text)=>[...host.querySelectorAll("button")].find(b=>b.textContent===text);
  const click=async(element)=>act(async()=>{element.click();await settle();});
  return {host,button,click,render:()=>act(async()=>{render();await settle();}),calls,saves,countSaves,dom};
}

async function mountResult(t,result=view("completed"),fetchHandler,sessionStatus="in_progress") {
  const dom=new JSDOM("<!doctype html><div id='root'></div>",{url:"http://localhost/history"});
  const observers=[];
  const originals={};
  for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,Element:dom.window.Element,
    HTMLElement:dom.window.HTMLElement,HTMLAnchorElement:dom.window.HTMLAnchorElement,navigator:dom.window.navigator,
    ResizeObserver:class {
      constructor(callback) { this.callback=callback;this.active=true;observers.push(this); }
      observe() {} disconnect() { this.active=false; }
    },IS_REACT_ACT_ENVIRONMENT:true})) {
    originals[name]=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
  }
  const {createRoot}=await import("react-dom/client");
  const router={pushes:[],push(path){this.pushes.push(path);}};
  const resultLoader=loader({
    "next/link":{default:({children,...props})=>React.createElement("a",props,children)},
    "next/navigation":{useRouter:()=>router},
  });
  const {QuestionResult}=resultLoader("src/app/(participant)/sessions/[sessionId]/question-result.tsx");
  const {ToastProvider}=resultLoader("src/app/toast.tsx");
  if(fetchHandler)t.mock.method(globalThis,"fetch",fetchHandler);
  const host=dom.window.document.getElementById("root"),root=createRoot(host);
  await act(async()=>{root.render(React.createElement(React.StrictMode,null,
    React.createElement(ToastProvider,null,React.createElement(QuestionResult,{result,sessionStatus}))));await settle();});
  let closed=false;
  const close=async()=>{
    if(closed)return;
    closed=true;
    await act(async()=>{root.unmount();await settle();});dom.window.close();
    for(const [name,descriptor] of Object.entries(originals)) {
      if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
    }
  };
  t.after(close);
  return {dom,host,close,router,observers};
}

for(const [name,opts] of [
  ["missing inputs",{input:{...valid,stage_id:null}}],
  ["no registered image",{imageCount:0}],
  ["image mutation/unresolved upload",{available:false}],
]) test(`component gates generation: ${name}`,async(t)=>{
  const ui=await mount(t,opts);assert.equal(ui.button("질문 생성하기").disabled,true);
  assert.equal(ui.calls.filter(c=>c.opts.method==="POST"&&c.url==="/api/question-generation").length,0);
});

test("component valid saved draft enables CTA; counts 1..5 immediately autosave and lock pending",async(t)=>{
  const ui=await mount(t);assert.equal(ui.button("질문 생성하기").disabled,false);
  assert.equal(ui.host.querySelector('input[name="question-count"]:checked').value,"3");
  for(const n of [1,2,3,4,5]) {
    await ui.click(ui.host.querySelector(`input[name="question-count"][value="${n}"]`));
    await act(async()=>{await new Promise(r=>setTimeout(r,5));await settle();});
    assert.equal(ui.countSaves.at(-1),n);
    assert.equal(ui.button("질문 생성하기").disabled,false);
  }
});

test("real context autosave pending/failed gates CTA, retry recovers, edits survive generation lock",async(t)=>{
  const pending=deferred();let fail=true;
  const ui=await mount(t,{saveResult:async()=>fail?pending.promise:{success:true,changed:true,activityRecorded:true}});
  const textarea=ui.host.querySelector("textarea");
  await act(async()=>{
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype,"value").set.call(textarea,"TEST edited context");
    textarea.dispatchEvent(new ui.dom.window.Event("input",{bubbles:true}));await settle();
  });
  assert.equal(ui.button("질문 생성하기").disabled,true);
  await act(async()=>{await new Promise(r=>setTimeout(r,1010));pending.resolve({success:false,message:"TEST save failed"});await settle();});
  assert.equal(ui.button("질문 생성하기").disabled,true);assert.ok(ui.button("저장 다시 시도"));
  fail=false;await ui.click(ui.button("저장 다시 시도"));
  assert.equal(ui.button("질문 생성하기").disabled,false);
  assert.equal(textarea.value,"TEST edited context");
});

for(const n of [1,3,5]) test(`component success N=${n}: one POST, authoritative slot result, reload/re-entry no POST`,async(t)=>{
  const ui=await mount(t,{initial:view("editable",n)});
  await ui.click(ui.button("질문 생성하기"));
  assert.equal(ui.host.querySelectorAll(".question-page-button").length,n);
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,`질문 1 / ${n}`);
  await ui.render();
  assert.equal(ui.calls.filter(c=>c.url==="/api/question-generation"&&c.opts.method==="POST").length,1);
  assert.doesNotMatch(ui.host.textContent,/candidate_rank|model|prompt|selection_reason/);
});

test("component immediate double click locks inputs/count/images with long-loading copy; 202 is not an error",async(t)=>{
  const pending=deferred();
  const ui=await mount(t,{postResult:async(req)=>{await pending.promise;return json({
    request_id:req,attempt_id:randomUUID(),status:"running",retry_same_request:true},202);},readResult:()=>view("running")});
  const generate=ui.button("질문 생성하기");
  await act(async()=>{generate.click();generate.click();await settle();});
  assert.equal(ui.calls.filter(c=>c.url==="/api/question-generation").length,1);
  assert.ok(ui.host.querySelector(".loading-state-overlay"));
  assert.equal(ui.host.querySelector(".session-wizard").hasAttribute("inert"),true);
  assert.equal(ui.host.querySelector("textarea").disabled,true);
  assert.equal(ui.host.querySelector('[data-testid="image-edit"]').disabled,true);
  assert.ok([...ui.host.querySelectorAll('input[name="question-count"]')].every(i=>i.closest("fieldset").disabled));
  assert.match(ui.host.textContent,/질문을 생성하고 있어요···/);
  assert.match(readFileSync("src/app/globals.css","utf8"),/background: rgb\(248 248 247 \/ 80%\)/);
  assert.doesNotMatch(ui.host.textContent,/\d+초|%/);
  await act(async()=>{pending.resolve();await settle();});
  assert.match(ui.host.textContent,/질문을 생성하고 있어요···/);
});

test("component safe failure re-enables edits and staged recovery remains locked",async(t)=>{
  const ui=await mount(t,{postResult:async()=>json({errorCode:"QGEN-API",message:"PRIVATE"},502),
    readResult:req=>({...view(),failed_request_id:req})});
  await ui.click(ui.button("질문 생성하기"));
  assert.equal(ui.host.querySelector("textarea").disabled,false);
  assert.equal(ui.button("질문 생성하기").disabled,false);assert.doesNotMatch(ui.host.textContent,/PRIVATE/);
});

for(const state of ["completed","recovery"]) test(`component ${state} re-entry never sends generation POST`,async(t)=>{
  const ui=await mount(t,{initial:view(state)});
  assert.equal(ui.calls.filter(c=>c.url==="/api/question-generation").length,0);
  if(state==="completed") assert.equal(ui.host.querySelectorAll(".question-page-button").length,3);
  else {assert.equal(ui.host.querySelector("textarea").disabled,true);assert.ok(ui.button("상태 확인"));}
});

test("result orders slots and renders answer controls without internal metadata",()=>{
  const {QuestionResult}=loader({
    "next/link":{default:({children,...p})=>React.createElement("a",p,children)},
    "next/navigation":{useRouter:()=>({push(){}})},
  })(
    "src/app/(participant)/sessions/[sessionId]/question-result.tsx");
  const html=renderToStaticMarkup(React.createElement(QuestionResult,{result:{
    ...view("completed"),questions:[...view("completed").questions].reverse(),
  }}));
  assert.ok(html.indexOf("질문 1")<html.indexOf("질문 2")&&html.indexOf("질문 2")<html.indexOf("질문 3"));
  assert.match(html,/object\/sign/);
  assert.match(html,/left:17\.5%;top:26%/);
  assert.match(html,/나의 생각/);
  assert.doesNotMatch(html,/aria-label="이전 질문"/);
  assert.doesNotMatch(html,/aria-label="다음 질문"/);
  assert.match(html,/class="question-panel-header"/);
  assert.doesNotMatch(html,/후보|candidate_rank|model|schema_version/);
  assert.match(readFileSync("src/app/globals.css","utf8"),/width:30px; height:30px/);
});

test("question generation loading is a centered full-screen overlay with supplied status copy",async(t)=>{
  const dom=new JSDOM("<!doctype html><div id='root'></div>");
  const originals={};
  for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,Element:dom.window.Element,
    IS_REACT_ACT_ENVIRONMENT:true})) {
    originals[name]=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
  }
  const {createRoot}=await import("react-dom/client");
  const {QuestionGenerationLoading}=loader()(
    "src/app/(participant)/sessions/[sessionId]/question-generation-loading.tsx");
  const host=dom.window.document.getElementById("root"),root=createRoot(host);
  let closed=false;
  const close=async()=>{
    if(closed)return;
    closed=true;
    await act(async()=>{root.unmount();await settle();});
    dom.window.close();
    for(const [name,descriptor] of Object.entries(originals)) {
      if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
    }
  };
  t.after(close);
  await act(async()=>{root.render(React.createElement(QuestionGenerationLoading,
    {message:"질문을 생성하고 있어요···"}));await settle();});
  assert.equal(host.querySelector(".loading-state-overlay").getAttribute("role"),"status");
  assert.equal(host.querySelector(".loading-state-overlay").getAttribute("aria-busy"),"true");
  assert.equal(host.querySelector(".loading-state-overlay .loading-state-spinner")!==null,true);
  assert.equal(host.querySelector(".loading-state-overlay > span:nth-of-type(2)").textContent,"질문을 생성하고 있어요···");
  assert.match(readFileSync("src/app/globals.css","utf8"),/z-index: 1200/);
  assert.match(readFileSync("src/app/globals.css","utf8"),/background: rgb\(20 20 22 \/ 80%\)/);
});

test("saved result pins, question navigation, multi-image scope and whole-image targets stay linked",async(t)=>{
  const ui=await mountResult(t);
  assert.equal(ui.host.querySelectorAll(".question-pin").length,3);
  await act(async()=>{ui.host.querySelector('[aria-label="질문 3 위치 보기"]').click();await settle();});
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 3 / 3");
  assert.equal(ui.host.querySelector(".question-panel-text").textContent,"TEST question 3");
  await act(async()=>{
    ui.host.querySelector(".question-panel").dispatchEvent(
      new ui.dom.window.KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,10));await settle();
  });
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 2 / 3");
  await ui.close();

  const result=structuredClone(view("completed"));
  const secondImage="60000000-0000-4000-8000-000000000002";
  result.images.push({id:secondImage,sort_order:1,width:600,height:1200,
    signed_url:"https://private-test.supabase.co/storage/v1/object/sign/why-box-images/test-2"});
  result.questions[0].targets.push({image_id:secondImage,x:null,y:null,width:null,height:null,sort_order:1});
  const multi=await mountResult(t,result);
  const thumbnails=multi.host.querySelectorAll(".question-image-thumbnail");
  assert.equal(thumbnails.length,2);
  await act(async()=>{multi.host.querySelector('[aria-label="이미지 2 보기"]').click();await settle();});
  assert.match(multi.host.querySelector(".question-result-image").getAttribute("src"),/test-2$/);
  assert.equal(multi.host.querySelector(".question-target-scope"),null);
  assert.equal([...multi.host.querySelectorAll(".question-pin")].some(pin=>pin.textContent==="1"),false);
  assert.equal(multi.host.querySelector(".question-image-frame").style.aspectRatio,"600/1200");
});

test("whole-image questions appear once on every image and selection activates the first image",async(t)=>{
  const result=structuredClone(view("completed",5));
  const secondImage="60000000-0000-4000-8000-000000000002";
  result.images.push({id:secondImage,sort_order:1,width:600,height:1200,
    signed_url:"https://private-test.supabase.co/storage/v1/object/sign/why-box-images/test-2"});
  for(const index of [0,2,4]) {
    result.questions[index].targets=[imageId,secondImage].map((id,sort_order)=>({
      image_id:id,x:null,y:null,width:null,height:null,sort_order,
    }));
  }
  let writes=0;
  const ui=await mountResult(t,result,async()=>{writes++;throw new Error("No save expected");});
  const row=()=>ui.host.querySelector(".question-whole-image-pins");
  assert.deepEqual([...row().querySelectorAll("button")].map(button=>button.textContent),["1","3","5"]);
  assert.equal(row().querySelector(".is-active").textContent,"1");
  await act(async()=>{ui.host.querySelector('[aria-label="이미지 2 보기"]').click();await settle();});
  assert.deepEqual([...row().querySelectorAll("button")].map(button=>button.textContent),["1","3","5"]);
  assert.match(ui.host.querySelector(".question-result-image").getAttribute("src"),/test-2$/);
  await act(async()=>{ui.host.querySelector('[aria-label="질문 3 전체 이미지 보기"]').click();await settle();});
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 3 / 5");
  assert.equal(row().querySelector(".is-active").textContent,"3");
  assert.match(ui.host.querySelector(".question-result-image").getAttribute("src"),/\/test$/);
  await act(async()=>{ui.host.querySelector('[aria-label="이미지 2 보기"]').click();await settle();});
  await act(async()=>{ui.host.querySelector('[aria-label="질문 5 선택"]').click();await settle();});
  assert.equal(row().querySelector(".is-active").textContent,"5");
  assert.match(ui.host.querySelector(".question-result-image").getAttribute("src"),/\/test$/);
  await act(async()=>{ui.host.querySelector('[aria-label="질문 2 선택"]').click();await settle();});
  assert.equal(row().querySelector(".is-active"),null);
  assert.equal(ui.host.querySelectorAll(".question-image-pins > .question-pin").length,2);
  assert.equal(writes,0);
});

test("briefing view clears every question pin active state and question selection restores it",async(t)=>{
  const ui=await mountResult(t,view("completed"),async url=>{
    if(url.includes("/briefing"))return json(briefingBody());
    throw new Error(`Unexpected request: ${url}`);
  },"completed");
  await act(async()=>{await settle();});
  assert.equal(ui.host.querySelector(".question-summary-tab")!==null,true);
  assert.equal(ui.host.querySelectorAll(".question-pin.is-active").length,0);
  assert.equal(ui.host.querySelectorAll(".question-page-button.is-active").length,0);
  await act(async()=>{ui.host.querySelector('[aria-label="질문 1 선택"]').click();await settle();});
  assert.equal(ui.host.querySelectorAll(".question-pin.is-active").length,1);
  await act(async()=>{ui.host.querySelector(".question-summary-tab").click();await settle();});
  assert.equal(ui.host.querySelectorAll(".question-pin.is-active").length,0);
  assert.equal(ui.host.querySelectorAll(".question-page-button.is-active").length,0);
  await act(async()=>{ui.host.querySelector('[aria-label="질문 1 선택"]').click();await settle();});
  assert.equal(ui.host.querySelectorAll(".question-pin.is-active").length,1);
  assert.equal(ui.host.querySelector(".question-page-button.is-active").getAttribute("aria-label"),"질문 1 선택");
  await ui.close();
});

test("session completion shows the briefing overlay only while the completion request is active",async t=>{
  const pending=deferred();
  const result=structuredClone(view("completed"));
  result.questions[1].status="skipped";
  result.questions[2].status="skipped";
  const ui=await mountResult(t,result,async(url,options)=>{
    if(url==="/api/question-answer")return json({success:true,updated_at:"2026-10-12T00:00:00.000Z"});
    if(url.endsWith("/complete")) {
      const request=JSON.parse(options.body);
      await pending.promise;
      return json({request_id:request.request_id,state:"completed",attempt_number:0,
        retry_of_request_id:null,missing_question_ids:[],has_answer:true,replayed:false,provider_mode:"mock"});
    }
    if(url.endsWith("/briefing"))return json(briefingBody());
    throw new Error(`Unexpected request: ${url}`);
  });
  const answer=ui.host.querySelector("#question-answer-text");
  await act(async()=>{
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype,"value")
      .set.call(answer,"TEST answer for completion");
    answer.dispatchEvent(new ui.dom.window.Event("input",{bubbles:true}));
    await settle();
  });
  await act(async()=>{ui.host.querySelector(".question-result-footer button").click();await settle();});
  const dialog=ui.host.querySelector('[role="dialog"]');
  assert.ok(dialog);
  await act(async()=>{[...dialog.querySelectorAll("button")].find(button=>button.textContent==="세션 종료").click();await settle();});
  assert.equal(ui.host.querySelector(".loading-state-overlay > span:nth-of-type(2)").textContent,"디자인 브리핑을 생성하고 있어요···");
  assert.equal(ui.host.querySelector(".question-result").hasAttribute("inert"),true);
  assert.equal(ui.host.querySelector(".loading-state-overlay").getAttribute("aria-busy"),"true");
  await act(async()=>{pending.resolve();await settle();});
  assert.equal(ui.host.querySelector(".loading-state-overlay"),null);
  assert.equal(ui.host.querySelector(".question-result").hasAttribute("inert"),false);
  await ui.close();
});

test("answers autosave before question navigation and remain isolated when returning",async(t)=>{
  const pending=deferred(),saves=[];
  const ui=await mountResult(t,view("completed"),async(url,options)=>{
    assert.equal(url,"/api/question-answer");
    saves.push(JSON.parse(options.body));
    return pending.promise;
  });
  const textarea=ui.host.querySelector("#question-answer-text");
  assert.equal(ui.host.querySelector(".question-panel-header .question-panel-count")!==null,true);
  assert.equal(ui.host.querySelectorAll(".question-panel-header .question-page-button").length,3);
  assert.equal(ui.host.querySelector(".question-arrow-button"),null);
  assert.equal(ui.host.querySelector(".question-answer-label"),null);
  assert.equal(textarea.getAttribute("aria-label"),"나의 생각");
  assert.equal(textarea.placeholder,"질문을 보고 떠오른 답변을 자유롭게 적어보세요.");
  await act(async()=>{
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype,"value")
      .set.call(textarea,"TEST first reflection");
    textarea.dispatchEvent(new ui.dom.window.Event("input",{bubbles:true}));
    await settle();
  });
  assert.equal(ui.host.querySelector(".question-answer-save-status").textContent,"저장 중");
  await act(async()=>{ui.host.querySelector('[aria-label="질문 2 선택"]').click();await settle();});
  assert.equal(saves.length,1);
  assert.equal(saves[0].answer_text,"TEST first reflection");
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 1 / 3");
  assert.equal(ui.host.querySelector("#question-answer-text").disabled,true);
  await act(async()=>{pending.resolve(json({success:true,updated_at:"2026-10-08T11:01:00.000Z"}));await settle();});
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 2 / 3");
  await act(async()=>{ui.host.querySelector('[aria-label="질문 1 선택"]').click();await settle();});
  assert.equal(ui.host.querySelector("#question-answer-text").value,"TEST first reflection");
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 1 / 3");
});

test("all uploaded images remain selectable even when the current question targets only one image",async(t)=>{
  const result=structuredClone(view("completed"));
  result.images.push({id:"60000000-0000-4000-8000-000000000002",sort_order:1,width:600,height:1200,
    signed_url:"https://private-test.supabase.co/storage/v1/object/sign/why-box-images/test-2"});
  const ui=await mountResult(t,result);
  assert.equal(ui.host.querySelectorAll(".question-image-thumbnail").length,2);
  await act(async()=>{ui.host.querySelector('[aria-label="이미지 2 보기"]').click();await settle();});
  assert.match(ui.host.querySelector(".question-result-image").getAttribute("src"),/test-2$/);
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 1 / 3");
  await act(async()=>{ui.host.querySelector('[aria-label="이미지 1 보기"]').click();await settle();});
  assert.match(ui.host.querySelector(".question-result-image").getAttribute("src"),/\/test$/);
  await act(async()=>{ui.host.querySelector("#question-answer-text").dispatchEvent(
    new ui.dom.window.KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));await settle();});
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 1 / 3");
  await act(async()=>{ui.host.querySelector('[aria-label="질문 2 선택"]').click();await settle();});
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 2 / 3");
});

test("sentence refinement snapshots autosaved text, locks navigation, preserves original and supports undo",async(t)=>{
  const refinement=deferred(),saveBodies=[],refineBodies=[];
  let refinementCalls=0;
  const ui=await mountResult(t,view("completed"),async(url,options)=>{
    if(url==="/api/question-answer") {
      saveBodies.push(JSON.parse(options.body));
      return json({success:true,updated_at:`2026-10-08T11:0${saveBodies.length}:00.000Z`});
    }
    assert.equal(url,"/api/sentence-refinement");
    refineBodies.push(JSON.parse(options.body));refinementCalls++;
    return refinement.promise;
  });
  const button=ui.host.querySelector(".question-refine-button");
  assert.equal(button.disabled,true);
  const textarea=ui.host.querySelector("#question-answer-text");
  await act(async()=>{
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype,"value")
      .set.call(textarea,"TEST author thought");
    textarea.dispatchEvent(new ui.dom.window.Event("input",{bubbles:true}));await settle();
  });
  assert.equal(button.disabled,false);
  await act(async()=>{button.click();button.click();await new Promise(resolve=>setTimeout(resolve,5));await settle();});
  assert.equal(saveBodies.length,1);
  assert.equal(refinementCalls,1);
  assert.deepEqual(Object.keys(refineBodies[0]).sort(),["expected_updated_at","question_id"]);
  assert.equal(refineBodies[0].expected_updated_at,"2026-10-08T11:01:00.000Z");
  assert.equal(ui.host.querySelector('[aria-label="질문 2 선택"]').disabled,true);
  assert.equal(ui.host.querySelector("#question-answer-text").disabled,true);
  assert.match(ui.host.textContent,/문장을 정리하고 있어요/);
  assert.equal(button.getAttribute("aria-busy"),"true");
  assert.equal(ui.host.querySelector(".question-answer-textarea.is-refining"),null);
  await act(async()=>{refinement.resolve(json({
    refined_text:"TEST refined thought",updated_at:"2026-10-08T11:02:00.000Z",
  }));await settle();});
  assert.equal(ui.host.querySelector("#question-answer-text").value,"TEST refined thought");
  assert.equal(ui.host.querySelector("#question-answer-text").classList.contains("has-answer-diff"),true);
  assert.match(ui.host.querySelector(".question-answer-diff-changed").textContent,/refined/);
  assert.equal(button.getAttribute("aria-busy"),"false");
  assert.match(ui.host.textContent,/문장을 다듬었어요/);
  const undo=ui.host.querySelector(".question-answer-version-button");
  assert.equal(undo.textContent,"원문으로 되돌리기");
  assert.equal(undo.parentElement.classList.contains("question-answer-statuses"),true);
  assert.equal(ui.host.querySelector(".question-answer-tools .question-refine-button")!==null,true);
  const css=readFileSync("src/app/globals.css","utf8");
  assert.match(css,/\.question-answer-version-button \{[^}]*top:-7px/);
  assert.match(css,/\.question-answer-version-button:hover:not\(:disabled\) \{ background:transparent; opacity:\.7; \}/);
  await act(async()=>{undo.click();await settle();});
  assert.equal(saveBodies.length,2);
  assert.equal(saveBodies[1].answer_text,"TEST author thought");
  assert.equal(saveBodies[1].answer_version,"original");
  assert.equal(ui.host.querySelector("#question-answer-text").value,"TEST author thought");
  assert.match(ui.host.textContent,/원문으로 되돌렸어요/);
});

test("refinement stale protection rejects local edits, wrong question and disposed editor",()=>{
    const {AnswerAutosave}=load("src/lib/answers/autosave.ts");
    const id=view("completed").questions[0].id;
    const snapshot={...view("completed").questions[0].answer,original_answer:"TEST original",
      updated_at:"2026-10-08T11:00:00.000Z"};
    for(const variant of ["edit","wrong-question","disposed","revision","version"]) {
      const controller=new AnswerAutosave({[id]:snapshot},async()=>({updated_at:"2026-10-08T11:01:00.000Z"}),()=>{});
      if(variant==="edit")controller.change(id,"TEST new edit",100_000);
      if(variant==="disposed")controller.dispose();
      const expected=variant==="revision"?{...snapshot,updated_at:"2026-10-08T10:59:00.000Z"}:
        variant==="version"?{...snapshot,current_answer_version:"refined"}:snapshot;
      assert.equal(controller.applyRefinement(variant==="wrong-question"?"unknown":id,
        "TEST old output","2026-10-08T11:02:00.000Z",expected),false);
      assert.equal(controller.getAnswer(id).refined_answer,null);
      assert.equal(controller.getAnswer(id).original_answer,variant==="edit"?"TEST new edit":"TEST original");
      controller.dispose();
    }
  });

  test("malformed refinement responses never replace text or disclose server metadata",async(t)=>{
    for(const body of [
      {refined_text:"",updated_at:"2026-10-08T11:01:00.000Z"},
      {refined_text:" ",updated_at:"2026-10-08T11:01:00.000Z"},
      {refined_text:"a".repeat(20_001),updated_at:"2026-10-08T11:01:00.000Z"},
      {refined_text:"TEST",updated_at:"invalid"},
      {refined_text:"TEST",updated_at:"2026-10-08T11:01:00.000Z",model:"PRIVATE"},
      null,
    ]) {
      const result=view("completed");result.questions[0].answer.original_answer="TEST preserved";
      result.questions[0].answer.updated_at="2026-10-08T11:00:00.000Z";
      const ui=await mountResult(t,result,async()=>json(body));
      await act(async()=>{ui.host.querySelector(".question-refine-button").click();await settle();});
      assert.equal(ui.host.querySelector("textarea").value,"TEST preserved");
      assert.equal(ui.host.querySelector(".question-refine-button").disabled,false);
      assert.doesNotMatch(ui.host.textContent,/PRIVATE/);
      assert.match(ui.host.textContent,/문장을 다듬지 못했어요/);
      await ui.close();
    }
  });

  test("pending refinement blocks fast navigation and ignores an unexpected local text edit",async(t)=>{
    const result=view("completed");result.questions[0].answer.original_answer="TEST initial";
    result.questions[0].answer.updated_at="2026-10-08T11:00:00.000Z";
    const pending=deferred();let calls=0;
    const ui=await mountResult(t,result,async(url)=>{
      assert.equal(url,"/api/sentence-refinement");calls++;return pending.promise;
    });
    await act(async()=>{
      ui.host.querySelector(".question-refine-button").click();await settle();
      ui.host.querySelector('[aria-label="질문 2 선택"]').click();
      ui.host.querySelector(".question-refine-button").click();await settle();
    });
    assert.equal(calls,1);
    assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 1 / 3");
    const textarea=ui.host.querySelector("textarea");
    assert.equal(textarea.disabled,true);
    await act(async()=>{
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype,"value").set.call(textarea,"TEST local change");
      textarea.dispatchEvent(new ui.dom.window.Event("input",{bubbles:true}));await settle();
      pending.resolve(json({refined_text:"TEST stale output",updated_at:"2026-10-08T11:01:00.000Z"}));await settle();
    });
    assert.equal(textarea.value,"TEST local change");
    assert.match(ui.host.textContent,/답변이 변경되었습니다/);
    assert.equal(result.questions[1].answer.refined_answer,null);
  });

  test("refinement client deadline unlocks with original retained and no automatic retry",async(t)=>{
    t.mock.timers.enable({apis:["setTimeout"]});
    const result=view("completed");result.questions[0].answer.original_answer="TEST retained";
    result.questions[0].answer.updated_at="2026-10-08T11:00:00.000Z";
    let calls=0;
    const ui=await mountResult(t,result,async(url,options)=>{
      assert.equal(url,"/api/sentence-refinement");calls++;
      return new Promise((resolve,reject)=>{
        options.signal.addEventListener("abort",()=>reject(new Error("mock deadline")),{once:true});
      });
    });
    await act(async()=>{ui.host.querySelector(".question-refine-button").click();await settle();});
    await act(async()=>{t.mock.timers.tick(65_000);await settle();});
    assert.equal(ui.host.querySelector("textarea").value,"TEST retained");
    assert.equal(ui.host.querySelector("textarea").disabled,false);
    assert.equal(ui.host.querySelector(".question-refine-button").disabled,false);
    assert.equal(calls,1);assert.match(ui.host.textContent,/문장을 다듬지 못했어요/);
  });

  test("saved refined and original versions restore on reentry without refinement calls",async(t)=>{
    for(const version of ["original","refined"]) {
      const result=view("completed");let calls=0;
      result.questions[0].answer={original_answer:"TEST author original",refined_answer:"TEST stored refined",
        refinement_used:true,current_answer_version:version,updated_at:"2026-10-08T11:00:00.000Z"};
      const ui=await mountResult(t,result,async()=>{calls++;throw new Error("No request expected");});
      assert.equal(ui.host.querySelector("textarea").value,version==="original"?"TEST author original":"TEST stored refined");
      assert.equal(calls,0);assert.equal(ui.host.querySelector(".question-answer-label"),null);
      assert.equal(ui.host.querySelector(".question-answer-save-status").textContent,"");
      const control=[...ui.host.querySelectorAll("button.text-link")].find(button=>button.textContent===
        (version==="original"?"다듬은 문장 다시 보기":"원문으로 되돌리기"));
      assert.ok(control);await ui.close();
    }
  });

test("failed answer saves and refinement preserve text, block unsafe navigation and allow retry",async(t)=>{
  let saveCalls=0,refinementCalls=0;
  const ui=await mountResult(t,view("completed"),async(url)=>{
    if(url==="/api/question-answer") {
      saveCalls++;
      return saveCalls===1?json({message:"TEST failure"},503):
        json({success:true,updated_at:"2026-10-08T11:01:00.000Z"});
    }
    refinementCalls++;
    return json({message:"TEST failure"},502);
  });
  const textarea=ui.host.querySelector("#question-answer-text");
  await act(async()=>{
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype,"value")
      .set.call(textarea,"TEST preserved text");
    textarea.dispatchEvent(new ui.dom.window.Event("input",{bubbles:true}));await settle();
  });
  await act(async()=>{ui.host.querySelector('[aria-label="질문 2 선택"]').click();await settle();});
  assert.equal(saveCalls,1);
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 1 / 3");
  assert.equal(ui.host.querySelector("#question-answer-text").value,"TEST preserved text");
  assert.equal(ui.host.querySelector(".question-answer-save-status").textContent,
    "저장 실패 · 입력한 내용은 유지되어 있어요.");
  await act(async()=>{ui.host.querySelector("button.text-link").click();await settle();});
  assert.equal(saveCalls,2);
  assert.equal(ui.host.querySelector(".question-answer-save-status").textContent,"");
  await act(async()=>{ui.host.querySelector(".question-refine-button").click();await settle();});
  assert.equal(refinementCalls,1);
  assert.equal(ui.host.querySelector("#question-answer-text").value,"TEST preserved text");
  assert.match(ui.host.textContent,/문장을 다듬지 못했어요/);
  assert.equal(ui.host.querySelector(".question-refine-button").disabled,false);
  await act(async()=>{ui.host.querySelector(".question-refine-button").click();await settle();});
  assert.equal(refinementCalls,2);
  assert.equal(ui.host.querySelector("#question-answer-text").value,"TEST preserved text");
});

test("save failures expose only safe codes and do not call refinement when prerequisite save fails",async(t)=>{
  let saves=0,refines=0;
  const ui=await mountResult(t,view("completed"),async(url)=>{
    if(url==="/api/question-answer") {
      saves++;return json({errorCode:"ANSWER-STALE",message:"PRIVATE server details"},409);
    }
    refines++;throw new Error("Refinement must not run");
  });
  await act(async()=>{
    const textarea=ui.host.querySelector("#question-answer-text");
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype,"value")
      .set.call(textarea,"TEST retained draft");
    textarea.dispatchEvent(new ui.dom.window.Event("input",{bubbles:true}));await settle();
    ui.host.querySelector(".question-refine-button").click();await settle();
  });
  assert.equal(saves,1);assert.equal(refines,0);
  assert.match(ui.host.querySelector(".toast-stack").textContent,/저장 상태가 변경/);
  assert.match(ui.host.querySelector(".toast-stack").textContent,/답변을 먼저 저장/);
  assert.doesNotMatch(ui.host.textContent,/PRIVATE/);
  assert.equal(ui.host.querySelector("textarea").value,"TEST retained draft");
  assert.equal(ui.host.querySelector('[aria-label="질문 2 선택"]').disabled,false);
});

test("disabled refinement is distinct from save failure and saved answers restore on reentry",async(t)=>{
  const result=structuredClone(view("completed"));
  result.questions[0].answer={original_answer:"TEST restored original",refined_answer:"TEST restored refined",
    refinement_used:true,current_answer_version:"refined",updated_at:"2026-10-08T11:00:00.123456+00:00"};
  let calls=0;
  for(let entry=0;entry<2;entry++) {
    const ui=await mountResult(t,result,async(url)=>{
      assert.equal(url,"/api/sentence-refinement");calls++;
      return json({errorCode:"REFINE-CONFIG",message:"PRIVATE"},503);
    });
    assert.equal(ui.host.querySelector("textarea").value,"TEST restored refined");
    assert.match(ui.host.textContent,/원문으로 되돌리기/);
    await act(async()=>{ui.host.querySelector(".question-refine-button").click();await settle();});
    assert.equal(ui.host.querySelector(".question-refinement-status"),null);
    assert.match(ui.host.querySelector(".toast-error").textContent,/활성화되지 않았거나 설정/);
    assert.equal(ui.host.querySelector(".question-answer-save-status").textContent,"");
    assert.equal(ui.host.querySelector("textarea").value,"TEST restored refined");
    assert.doesNotMatch(ui.host.textContent,/PRIVATE/);
    await ui.close();
  }
  assert.equal(calls,2);
});

test("pin navigation flushes the answer before selecting another question",async(t)=>{
  const pending=deferred();let saves=0;
  const ui=await mountResult(t,view("completed"),async()=>{saves++;return pending.promise;});
  await act(async()=>{
    const textarea=ui.host.querySelector("textarea");
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype,"value")
      .set.call(textarea,"TEST pin-navigation draft");
    textarea.dispatchEvent(new ui.dom.window.Event("input",{bubbles:true}));await settle();
    ui.host.querySelector('[aria-label="질문 3 위치 보기"]').click();await settle();
  });
  assert.equal(saves,1);
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 1 / 3");
  await act(async()=>{pending.resolve(json({success:true,updated_at:"2026-10-08T11:02:00.123456+00:00"}));await settle();});
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 3 / 3");
  await act(async()=>{ui.host.querySelector('[aria-label="질문 1 선택"]').click();await settle();});
  assert.equal(ui.host.querySelector("textarea").value,"TEST pin-navigation draft");
});

test("refinement permission errors use a toast and question text has semibold weight",async(t)=>{
  const result=structuredClone(view("completed"));
  result.questions[0].answer={...result.questions[0].answer,original_answer:"TEST saved answer",
    updated_at:"2026-10-08T11:00:00.123456+00:00"};
  const ui=await mountResult(t,result,async(url)=>{
    assert.equal(url,"/api/sentence-refinement");
    return json({errorCode:"REFINE-AUTH",message:"PRIVATE"},403);
  });
  await act(async()=>{ui.host.querySelector(".question-refine-button").click();await settle();});
  assert.equal(ui.host.querySelector(".question-refinement-status"),null);
  assert.equal(ui.host.querySelector(".toast-error").textContent,"문장을 다듬을 권한이 없습니다.");
  assert.equal(ui.host.querySelector("textarea").value,"TEST saved answer");
  assert.doesNotMatch(ui.host.textContent,/PRIVATE/);
  assert.match(readFileSync("src/app/globals.css","utf8"),
    /\.question-panel-text \{[^}]*font-weight:var\(--font-weight-semibold\)/);
});

test("read-only results allow question and image browsing without answer or refinement writes",async(t)=>{
  const result=structuredClone(view("completed"));
  result.answer_editable=false;
  result.images.push({...result.images[0],id:"60000000-0000-4000-8000-000000000002",sort_order:1});
  let writes=0;
  const ui=await mountResult(t,result,async()=>{writes++;throw new Error("Writes forbidden");});
  assert.equal(ui.host.querySelector("textarea").disabled,true);
  assert.equal(ui.host.querySelector(".question-refine-button").disabled,true);
  await act(async()=>{ui.host.querySelector('[aria-label="질문 2 선택"]').click();await settle();});
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 2 / 3");
  await act(async()=>{ui.host.querySelector('[aria-label="이미지 2 보기"]').click();await settle();});
  assert.equal(ui.host.querySelector('[aria-label="이미지 2 보기"]').getAttribute("aria-pressed"),"true");
  assert.equal(writes,0);
});

function actionableView(n=3) {
  const result=view("completed",n);
  result.question_actions={ready:true,reserve_count:5-n,
    reserve_count_by_question:Object.fromEntries(result.questions.map(question=>[question.id,5-n]))};
  return result;
}
function actionResponse(input,next,questionId=input.question_id) {
  next.question_actions={...next.question_actions,reserve_count_by_question:
    Object.fromEntries(next.questions.map(question=>[question.id,0]))};
  if(next.question_actions.regeneration)next.question_actions.regeneration={
    ...next.question_actions.regeneration,
    per_question:next.questions.map(question=>({question_id:question.id,reserve_count:0})),
  };
  return json({request_id:input.request_id,question_id:input.question_id,
    result_question_id:questionId,changed:true,view:next,activity_recorded:true});
}

test("unavailable question actions use a toast without inline setup, saved text or visible answer label",async(t)=>{
  const ui=await mountResult(t);
  assert.equal(ui.host.querySelector(".question-action-status"),null);
  assert.equal(ui.host.querySelector(".question-answer-save-status").textContent,"");
  assert.equal(ui.host.querySelector(".question-answer-label"),null);
  assert.equal(ui.host.querySelector("textarea").getAttribute("aria-label"),"나의 생각");
  const regenerate=ui.host.querySelector('[aria-label="현재 질문 재생성"]');
  assert.equal(regenerate.disabled,false);
  assert.match(regenerate.title,/질문 변경 기능은 DB 적용 승인 후/);
  await act(async()=>{
    regenerate.click();
    await new Promise(resolve=>setTimeout(resolve,10));
    await settle();
  });
  const toast=ui.host.querySelector(".toast-box");
  assert.ok(toast,ui.host.innerHTML);
  assert.match(toast.textContent,/질문 변경 기능은 DB 적용 승인 후/);
  assert.equal(ui.host.querySelectorAll(".toast-box").length,1);
  assert.equal(ui.host.querySelector('a[href="/history"]').textContent,"나의기록으로");
  assert.equal(ui.host.querySelector(".question-result-footer").classList.contains("wizard-footer"),true);
  assert.equal(ui.host.querySelector(".question-result-footer .wizard-actions button").textContent,"세션 종료");
  assert.match(readFileSync("src/app/globals.css","utf8"),
    /\.question-panel-count \{[^}]*color:var\(--color-text-muted\)/);
});

test("result panel avoids nested scrolling and refinement stays underlined with explicit theme colors",()=>{
  const css=readFileSync("src/app/globals.css","utf8");
  assert.match(css,/\.question-panel-content \{[^}]*overflow:visible/);
  assert.doesNotMatch(css,/\.question-panel-content \{[^}]*overflow-y:auto/);
  assert.doesNotMatch(css,/\.question-answer-actions \{[^}]*overflow-y:auto/);
  assert.match(css,/\.question-answer-textarea \{[^}]*overflow-y:auto/);
  assert.match(css,/\.question-refine-button \{[^}]*color:#000;[^}]*text-decoration:underline/);
  assert.match(css,/\.question-refine-button:disabled \{[^}]*opacity:1/);
  assert.match(css,/\.question-refine-button \{[^}]*top:-8px/);
  assert.match(css,/\.question-refine-button:hover:not\(:disabled\) \{[^}]*background:transparent;[^}]*opacity:\.75/);
  assert.match(css,/\.question-pin \{[^}]*border:2px solid/);
  assert.match(css,/\.question-pin\.is-active \{[^}]*box-shadow:0 0 0 2px/);
  assert.match(css,/\.participant-shell\[data-theme="dark"\] \.question-refine-button \{ color:#fff; \}/);
});

test("an unavailable action response is reported in a toast and unlocks editing",async(t)=>{
  const ui=await mountResult(t,actionableView(),async()=>json({errorCode:"QA-UNAVAILABLE"},409));
  await act(async()=>{ui.host.querySelector('[aria-label="현재 질문 건너뛰기"]').click();await settle();});
  assert.match(ui.host.querySelector(".toast-box").textContent,/DB 적용 승인/);
  assert.equal(ui.host.querySelector("textarea").disabled,false);
});

for(const n of [1,3,5])test(`N=${n}: question actions and refinement have lightweight semantics and associated answer label`,async(t)=>{
  const ui=await mountResult(t,actionableView(n));
  const regenerate=ui.host.querySelector('[aria-label="현재 질문 재생성"]');
  const skip=ui.host.querySelector('[aria-label="현재 질문 건너뛰기"]');
  assert.ok(regenerate);assert.ok(skip);
  assert.equal(regenerate.className,"question-text-action");assert.equal(skip.className,"question-text-action");
  assert.match(skip.textContent,/질문 건너뛰기/);
  assert.equal(skip.getAttribute("aria-busy"),"false");
  assert.equal(skip.querySelector('[aria-hidden="true"]').textContent,"↪");
  assert.match(readFileSync("src/app/globals.css","utf8"),
    /\.question-text-action:disabled \{[^}]*color:var\(--color-text-secondary\)/);
  assert.equal(regenerate.disabled,false);
  assert.equal(regenerate.getAttribute("aria-disabled"),String(n===5));
  assert.equal(skip.disabled,false);
  const refine=ui.host.querySelector(".question-refine-button");
  assert.equal(refine.tagName,"BUTTON");assert.equal(refine.classList.contains("button-secondary"),false);
  assert.equal(ui.host.querySelector("textarea").getAttribute("aria-label"),"나의 생각");
  assert.equal(ui.host.querySelector(".question-answer-label"),null);
  assert.equal(ui.host.querySelectorAll(".question-panel-header .question-page-button").length,n);
});

test("skip persists skipped question/pin, advances to next unprocessed slot and restores on reentry",async(t)=>{
  let saved;
  const ui=await mountResult(t,actionableView(),async(url,options)=>{
    assert.equal(url,"/api/question-action");
    const input=JSON.parse(options.body);
    assert.equal(input.action,"skip");assert.equal(input.expected_answer_revision,null);
    saved=actionableView();saved.questions[0].status="skipped";
    return actionResponse(input,saved);
  });

  await act(async()=>{ui.host.querySelector('[aria-label="현재 질문 건너뛰기"]').click();await settle();});
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 2 / 3");
  assert.equal(ui.dom.window.document.activeElement,ui.host.querySelector(".question-panel-header"));
  assert.equal(ui.host.querySelectorAll(".question-pin").length,3);
  await act(async()=>{ui.host.querySelector('[aria-label="질문 1 선택"]').click();await settle();});
  assert.doesNotMatch(ui.host.textContent,/건너뛴 질문/);
  assert.equal(ui.host.querySelector("textarea").placeholder,
    "건너뛴 질문이며 답변을 입력할 수 없습니다.");
  assert.equal(ui.host.querySelector("textarea").disabled,true);
  assert.equal(ui.host.querySelector('[aria-label="현재 질문 건너뛰기"]').disabled,true);
  const regenerate=ui.host.querySelector('[aria-label="현재 질문 재생성"]');
  assert.equal(regenerate.disabled,false);
  assert.equal(regenerate.title,"");
  assert.equal(regenerate.getAttribute("aria-disabled"),"false");
  await ui.close();
  const reentry=await mountResult(t,saved);
  assert.equal(reentry.host.querySelector("textarea").disabled,true);
  assert.doesNotMatch(reentry.host.textContent,/건너뛴 질문/);
  assert.match(reentry.host.querySelector("textarea").placeholder,/건너뛴 질문.*답변을 입력할 수 없습니다/);
  const css=readFileSync("src/app/globals.css","utf8");
  assert.match(css,/\.question-answer-textarea:disabled \{ background:#e4e4e2; border-color:#cececb; color:#666; opacity:1; \}/);
  assert.match(css,/\.participant-shell\[data-theme="dark"\] \.question-answer-textarea:disabled \{ background:rgb\(255 255 255 \/ 8%\); border-color:rgb\(255 255 255 \/ 20%\); color:#bdbdbd; box-shadow:none; outline:none; \}/);
});

test("skip shows a button-level busy state until its action result is received",async(t)=>{
  let resolveAction;
  const ui=await mountResult(t,actionableView(),async()=>new Promise(resolve=>{resolveAction=resolve;}));
  await act(async()=>{
    ui.host.querySelector('[aria-label="현재 질문 건너뛰기"]').click();
    await settle();
  });
  const skip=ui.host.querySelector('[aria-label="현재 질문 건너뛰기"]');
  assert.equal(skip.getAttribute("aria-busy"),"true");
  assert.match(skip.textContent,/질문을 건너뛰는 중/);
  assert.ok(skip.querySelector(".loading-state-spinner"));
  assert.equal(typeof resolveAction,"function");
  await act(async()=>{
    resolveAction(json({errorCode:"QA-DB"}));
    await settle();
  });
});

test("question actions use neutral theme hover colors and refinement label has no space",async(t)=>{
  const ui=await mountResult(t,actionableView());
  assert.equal(ui.host.querySelector(".question-refine-button").textContent.trim(),"✦문장다듬기");
  assert.ok(ui.host.querySelector(".question-refine-label"));
  const css=readFileSync("src/app/globals.css","utf8");
  assert.match(css,/\.question-refine-button \{[^}]*gap:0;/);
  assert.match(css,/\.question-text-action \{[^}]*color:#000/);
  assert.match(css,/\.question-text-action:hover:not\(:disabled\):not\(\[aria-disabled="true"\]\):not\(\.question-refine-button\) \{ background:#ededed; color:#000; \}/);
  assert.match(css,/\.participant-shell\[data-theme="dark"\] \.question-text-action:hover[^}]*background:rgb\(255 255 255 \/ 10%\); color:#fff/);
  assert.match(css,/\.question-text-action\[aria-disabled="true"\]:hover \{ background:transparent/);
  assert.match(css,/question-refine-button\[aria-busy="true"\] \.question-refine-label/);
});

test("briefing and classification controls use the requested filled and dark-theme states",()=>{
  const css=readFileSync("src/app/globals.css","utf8");
  const appCss=readFileSync("src/app/app.css","utf8");
  assert.match(css,/\.question-summary-tab svg \{[^}]*fill:currentColor/);
  assert.match(css,/\.briefing-copy-button:hover:not\(:disabled\) \{[^}]*opacity:\.7/);
  assert.match(appCss,/\.participant-shell\[data-theme="dark"\] \.category-trigger\.button-secondary\[data-selected="true"\]/);
});

function apiRegenerationView() {
  const result=actionableView(3);
  result.question_actions.reserve_count=0;
  result.question_actions.regeneration={ready:true,calls_remaining:3,pending_request_id:null,
    pending_question_id:null,per_question:result.questions.map(q=>({question_id:q.id,reserve_count:0}))};
  return result;
}
test("API fallback keeps current question/pin during processing and polls GET, never repeats POST",async(t)=>{
  const result=apiRegenerationView(),calls=[],pending=deferred();
  let request;
  const ui=await mountResult(t,result,async(url,options={})=>{
    calls.push({url,method:options.method});
    if(options.method==="POST") {
      request=JSON.parse(options.body);
      return json({request_id:request.request_id,question_id:request.question_id,status:"dispatch_started",
        attempt_id:randomUUID(),result_question_id:null,changed:false,method:"api_generated",retry_after_ms:1000},202);
    }
    assert.match(url,/request_id=/);return pending.promise;
  });
  await act(async()=>{
    const button=ui.host.querySelector('[aria-label="현재 질문 재생성"]');
    button.click();button.click();await settle();
  });
  assert.equal(ui.host.querySelector(".question-panel-text").textContent,result.questions[0].question_text);
  assert.equal(ui.host.querySelector('[aria-label="질문 2 선택"]').disabled,true);
  await act(async()=>{await new Promise(r=>setTimeout(r,1050));await settle();});
  assert.equal(calls.filter(c=>c.method==="POST").length,1);
  assert.equal(calls.filter(c=>!c.method).length,1);
  const next=structuredClone(result);
  next.questions[0]={...next.questions[0],id:randomUUID(),question_text:"합성 신규 관점 질문",
    regeneration_index:1,targets:[{image_id:imageId,x:.5,y:.5,width:.2,height:.2,sort_order:0}]};
  await act(async()=>{pending.resolve(actionResponse(request,next,next.questions[0].id));await settle();});
  assert.equal(ui.host.querySelector(".question-panel-text").textContent,"합성 신규 관점 질문");
  assert.equal(ui.host.querySelector('[aria-label="질문 1 위치 보기"]').style.left,"60%");
});
test("refresh restores pending request and manual recovery reads GET with same ID without generating",async(t)=>{
  const result=apiRegenerationView(),calls=[];
  const request={session_id:sessionId,question_id:result.questions[0].id,request_id:randomUUID(),action:"regenerate"};
  result.question_actions.regeneration.pending_request_id=request.request_id;
  result.question_actions.regeneration.pending_question_id=request.question_id;
  const next=structuredClone(result);next.question_actions.regeneration.pending_request_id=null;
  next.question_actions.regeneration.pending_question_id=null;
  next.questions[0]={...next.questions[0],id:randomUUID(),regeneration_index:1,question_text:"복구된 합성 질문"};
  const ui=await mountResult(t,result,async(url,options={})=>{
    calls.push({url,method:options.method});return actionResponse(request,next,next.questions[0].id);
  });
  assert.match(ui.host.textContent,/같은 요청으로 결과 다시 확인/);
  assert.equal(ui.host.querySelector('[aria-label="질문 2 선택"]').disabled,true);
  await act(async()=>{ui.host.querySelector(".toast-actions button").click();await settle();});
  assert.equal(calls.length,1);assert.equal(calls[0].method,undefined);
  assert.match(calls[0].url,new RegExp(request.request_id));
  assert.equal(ui.host.querySelector(".question-panel-text").textContent,"복구된 합성 질문");
});
test("API budget exhaustion and unavailable flag block fallback while reserve remains usable",async(t)=>{
  const result=apiRegenerationView();result.question_actions.regeneration.calls_remaining=0;
  const ui=await mountResult(t,result,async()=>{throw new Error("Must not send");});
  assert.equal(ui.host.querySelector('[aria-label="현재 질문 재생성"]').getAttribute("aria-disabled"),"true");
  await act(async()=>{ui.host.querySelector('[aria-label="현재 질문 재생성"]').click();await settle();});
  assert.match(ui.host.querySelector(".toast-box").textContent,/횟수를 모두 사용/);
  await ui.close();
  result.question_actions.regeneration.per_question[0].reserve_count=1;
  const reserve=await mountResult(t,result);
  assert.equal(reserve.host.querySelector('[aria-label="현재 질문 재생성"]').getAttribute("aria-disabled"),"false");
});
test("unanswered skipped question regenerates while skip and answer stay disabled; failure keeps pins",async(t)=>{
  const result=apiRegenerationView();result.questions[0].status="skipped";
  const ui=await mountResult(t,result,async()=>json({errorCode:"QR-DUPLICATE"},422));
  assert.equal(ui.host.querySelector('[aria-label="현재 질문 재생성"]').disabled,false);
  assert.equal(ui.host.querySelector('[aria-label="현재 질문 건너뛰기"]').disabled,true);
  assert.equal(ui.host.querySelector("textarea").disabled,true);
  const pin=ui.host.querySelector(".question-pin").style.cssText;
  await act(async()=>{ui.host.querySelector('[aria-label="현재 질문 재생성"]').click();await settle();});
  assert.equal(ui.host.querySelector(".question-panel-text").textContent,result.questions[0].question_text);
  assert.equal(ui.host.querySelector(".question-pin").style.cssText,pin);
  assert.match(ui.host.querySelector(".toast-stack").textContent,/다른 관점/);
});

test("reserve replacement locks duplicate/navigation and updates text/pin/ID without moving another slot's answer",async(t)=>{
  const result=actionableView();
  result.questions[1].answer={...result.questions[1].answer,original_answer:"TEST other saved answer",
    updated_at:"2026-10-09T00:00:00.123456+00:00"};
  const pending=deferred();const calls=[];
  const ui=await mountResult(t,result,async(url,options)=>{
    assert.equal(url,"/api/question-action");calls.push(JSON.parse(options.body));return pending.promise;
  });
  await act(async()=>{
    const button=ui.host.querySelector('[aria-label="현재 질문 재생성"]');
    button.click();button.click();await settle();
  });
  assert.equal(calls.length,1);
  assert.equal(ui.host.querySelector('[aria-label="현재 질문 건너뛰기"]').disabled,true);
  assert.equal(ui.host.querySelector('[aria-label="질문 2 선택"]').disabled,true);
  assert.equal(ui.host.querySelector(".question-pin").disabled,true);
  assert.match(ui.host.textContent,/질문을 바꾸는 중/);
  const next=structuredClone(result);
  next.question_actions.reserve_count=1;
  next.questions[0]={...next.questions[0],id:"50000000-0000-4000-8000-000000000099",
    question_text:"TEST replacement",regeneration_index:1,
    targets:[{image_id:imageId,x:0.6,y:0.7,width:0.1,height:0.1,sort_order:0}]};
  await act(async()=>{pending.resolve(actionResponse(calls[0],next,next.questions[0].id));await settle();});
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 1 / 3");
  assert.equal(ui.host.querySelector(".question-panel-text").textContent,"TEST replacement");
  assert.equal(ui.host.querySelector('[aria-label="질문 1 위치 보기"]').style.left,"65%");
  assert.equal(ui.host.querySelector("textarea").value,"");
  await act(async()=>{ui.host.querySelector('[aria-label="질문 2 선택"]').click();await settle();});
  assert.equal(ui.host.querySelector("textarea").value,"TEST other saved answer");
  await ui.close();
  const reentry=await mountResult(t,next);
  assert.equal(reentry.host.querySelector(".question-panel-text").textContent,"TEST replacement");
});

test("ambiguous action response retains request ID and requires explicit retry without another candidate consumption",async(t)=>{
  const calls=[];
  const ui=await mountResult(t,actionableView(),async(url,options)=>{
    assert.equal(url,"/api/question-action");const input=JSON.parse(options.body);calls.push(input);
    if(calls.length===1)throw new Error("TEST response lost");
    const next=actionableView();next.questions[0].status="skipped";return actionResponse(input,next);
  });
  await act(async()=>{ui.host.querySelector('[aria-label="현재 질문 건너뛰기"]').click();await settle();});
  assert.equal(calls.length,1);
  assert.equal(ui.host.querySelector("textarea").disabled,true);
  assert.equal(ui.host.querySelector('[aria-label="질문 2 선택"]').disabled,true);
  const retry=[...ui.host.querySelectorAll("button")].find(button=>button.textContent==="같은 요청으로 결과 다시 확인");
  assert.ok(retry);
  await act(async()=>{retry.click();await settle();});
  assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0]);
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 2 / 3");
});

test("stale action response never applies another session or question and confirmed failure unlocks",async(t)=>{
  let calls=0;
  const ui=await mountResult(t,actionableView(),async(url,options)=>{
    assert.equal(url,"/api/question-action");calls++;
    const input=JSON.parse(options.body);
    if(calls===1) {
      const next=actionableView();next.session_id="20000000-0000-4000-8000-000000000099";
      return actionResponse(input,next);
    }
    return json({errorCode:"QA-STALE",message:"PRIVATE"},409);
  });
  await act(async()=>{ui.host.querySelector('[aria-label="현재 질문 재생성"]').click();await settle();});
  assert.equal(ui.host.querySelector(".question-panel-text").textContent,"TEST question 1");
  assert.equal(ui.host.querySelector("textarea").disabled,true);
  await act(async()=>{
    [...ui.host.querySelectorAll("button")].find(button=>button.textContent==="같은 요청으로 결과 다시 확인").click();await settle();
  });
  assert.equal(ui.host.querySelector("textarea").disabled,false);
  assert.doesNotMatch(ui.host.textContent,/PRIVATE/);
});

for(const action of ["skip","regenerate"])test(`${action} replay reconciles a later active version without repeating the mutation`,async(t)=>{
  const calls=[];
  const ui=await mountResult(t,actionableView(),async(url,options)=>{
    assert.equal(url,"/api/question-action");
    const input=JSON.parse(options.body);calls.push(input);
    if(calls.length===1)throw new Error("TEST acknowledged response lost");
    const next=actionableView();
    next.questions[0]={...next.questions[0],id:"50000000-0000-4000-8000-000000000098",
      regeneration_index:action==="skip"?1:2,question_text:"TEST later active question"};
    next.question_actions.reserve_count_by_question=Object.fromEntries(next.questions.map(question=>[question.id,0]));
    if(next.question_actions.regeneration)next.question_actions.regeneration.per_question=
      next.questions.map(question=>({question_id:question.id,reserve_count:0}));
    return json({request_id:input.request_id,question_id:input.question_id,
      result_question_id:action==="skip"?input.question_id:"50000000-0000-4000-8000-000000000099",
      changed:false,view:next,activity_recorded:true});
  });
  await act(async()=>{
    ui.host.querySelector(`[aria-label="현재 질문 ${action==="skip"?"건너뛰기":"재생성"}"]`).click();await settle();
  });
  await act(async()=>{
    [...ui.host.querySelectorAll("button")].find(button=>button.textContent==="같은 요청으로 결과 다시 확인").click();await settle();
  });
  assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);
  assert.equal(ui.host.querySelector(".question-panel-count").textContent,"질문 1 / 3");
  assert.equal(ui.host.querySelector(".question-panel-text").textContent,"TEST later active question");
  assert.equal(ui.host.querySelector("textarea").disabled,false);
  assert.match(ui.host.textContent,/다른 화면에서 변경된 최신 질문/);
  assert.equal([...ui.host.querySelectorAll(".toast-box:not(.is-exiting)")].some(toast=>
    toast.textContent.includes("같은 요청으로 결과 다시 확인")),false);
});

test("same-index replacement mismatches and malformed activity acknowledgements remain recoverable",async(t)=>{
  for(const variant of ["same-index","activity"]) {
    const ui=await mountResult(t,actionableView(),async(url,options)=>{
      assert.equal(url,"/api/question-action");
      const input=JSON.parse(options.body);const next=actionableView();
      next.questions[0]={...next.questions[0],id:"50000000-0000-4000-8000-000000000098",
        regeneration_index:1,question_text:"TEST unexpected question"};
      return json({request_id:input.request_id,question_id:input.question_id,
        result_question_id:variant==="same-index"?"50000000-0000-4000-8000-000000000099":next.questions[0].id,
        changed:true,view:next,activity_recorded:variant==="activity"?"invalid":true});
    });
    await act(async()=>{ui.host.querySelector('[aria-label="현재 질문 재생성"]').click();await settle();});
    assert.equal(ui.host.querySelector(".question-panel-text").textContent,"TEST question 1");
    assert.equal(ui.host.querySelector("textarea").disabled,true);
    assert.match(ui.host.textContent,/같은 요청으로 결과 다시 확인/);
    await ui.close();
  }
});

test("authored original/refined text, read-only state, unavailable DB and exhausted limit block mutations",async(t)=>{
  for(const variant of ["original","refined","read-only","unavailable","limit"]) {
    const result=actionableView();let calls=0;
    if(variant==="original")result.questions[0].answer.original_answer="TEST original";
    if(variant==="refined")result.questions[0].answer={...result.questions[0].answer,
      original_answer:"",refined_answer:"TEST preserved refined",refinement_used:true,
      current_answer_version:"refined",updated_at:"2026-10-09T00:00:00Z"};
    if(variant==="read-only")result.answer_editable=false;
    if(variant==="unavailable")result.question_actions.ready=false;
    if(variant==="limit")result.questions[0].regeneration_index=2;
    const ui=await mountResult(t,result,async()=>{calls++;throw new Error("Mutation forbidden");});
    const regenerate=ui.host.querySelector('[aria-label="현재 질문 재생성"]');
    assert.equal(regenerate.getAttribute("aria-disabled"),"true");
    assert.equal(regenerate.disabled,false);
    assert.ok(regenerate.title);
    assert.equal(ui.host.querySelector(".question-action-status"),null);
    await act(async()=>{regenerate.click();await settle();});
    assert.ok([...ui.host.querySelectorAll(".toast-box")].some(toast=>toast.textContent===regenerate.title));
    if(variant!=="limit")assert.equal(ui.host.querySelector('[aria-label="현재 질문 건너뛰기"]').disabled,true);
    assert.equal(calls,0);await ui.close();
  }
});

test("exhausted reserves explain regeneration through tooltip and repeatable toast without requests",async(t)=>{
  let calls=0;
  const ui=await mountResult(t,actionableView(5),async()=>{calls++;throw new Error("Mutation forbidden");});
  const regenerate=ui.host.querySelector('[aria-label="현재 질문 재생성"]');
  assert.equal(regenerate.title,"사용하지 않은 준비 질문이 없어 재생성할 수 없습니다.");
  assert.equal(regenerate.getAttribute("aria-disabled"),"true");
  assert.equal(ui.host.querySelector(".question-action-status"),null);
  assert.equal(ui.host.querySelector(".toast-box"),null);
  for(let i=0;i<2;i++) {
    await act(async()=>{regenerate.click();await settle();});
    assert.ok([...ui.host.querySelectorAll(".toast-box:not(.is-exiting)")].some(toast=>toast.textContent===regenerate.title));
  }
  assert.equal(ui.host.querySelector("textarea").disabled,false);
  assert.equal(calls,0);
});

test("question count pending/failure serializes latest changes and requires explicit successful retry",async(t)=>{
  const pending=deferred();let fail=true;
  const ui=await mount(t,{countSaveResult:async()=>fail?pending.promise:{success:true,changed:true,activityRecorded:true}});
  await ui.click(ui.host.querySelector('input[name="question-count"][value="1"]'));
  await act(async()=>{await new Promise(r=>setTimeout(r,5));});
  assert.equal(ui.button("질문 생성하기").disabled,true);
  const link=ui.dom.window.document.createElement("a");link.href="/history";ui.host.appendChild(link);
  const event=new ui.dom.window.MouseEvent("click",{bubbles:true,cancelable:true});
  await act(async()=>{link.dispatchEvent(event);await settle();});
  assert.equal(event.defaultPrevented,true);
  assert.equal([...ui.host.querySelectorAll("p")].filter(p=>p.textContent.includes("아직 저장되지 않은 입력")).length,1);
  const unload=new ui.dom.window.Event("beforeunload",{cancelable:true});
  ui.dom.window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
  link.remove();
  await ui.click(ui.host.querySelector('input[name="question-count"][value="5"]'));
  await act(async()=>{await new Promise(r=>setTimeout(r,5));});
  assert.deepEqual(ui.countSaves,[1]);
  await act(async()=>{pending.resolve({success:false,message:"TEST count failed"});await settle();});
  assert.equal(ui.button("질문 생성하기").disabled,true);
  assert.equal(ui.host.querySelector('input[name="question-count"]:checked').value,"5");
  fail=false;await ui.click(ui.button("질문 개수 저장 다시 시도"));
  assert.deepEqual(ui.countSaves,[1,5]);assert.equal(ui.button("질문 생성하기").disabled,false);
});

test("Context Draft loading gates generation; automatic mock draft flows through existing autosave",async(t)=>{
  const pending=deferred();
  const ui=await mount(t,{input:{...valid,additional_context:null},draftResult:async body=>{
    await pending.promise;return json({request_id:body.request_id,draft_text:"TEST accepted draft"});
  }});
  assert.equal(ui.button("질문 생성하기").disabled,true);
  assert.equal(ui.calls.filter(c=>c.url==="/api/context-draft").length,1);
  await act(async()=>{pending.resolve();await settle();});
  assert.equal(ui.host.querySelector("textarea").value,"TEST accepted draft");
  assert.equal(ui.button("질문 생성하기").disabled,true);
  await act(async()=>{await new Promise(r=>setTimeout(r,1010));await settle();});
  assert.equal(ui.saves.at(-1).additional_context,"TEST accepted draft");
  assert.equal(ui.button("질문 생성하기").disabled,false);
});

test("GET authenticates owner and is no-store without generation/trusted writes; rejects inaccessible requests safely",async(t)=>{
  t.mock.method(console,"error",()=>{});
  const {NextRequest}=require("next/server");
  for(const variant of ["valid","anonymous","admin","inactive","foreign","db-error","bad-id"]) {
    const calls=[];
    const owner=randomUUID();
    const completed=view("completed");
    const caller={
      auth:{getUser:async()=>({data:{user:variant==="anonymous"?null:{id:owner}},error:null})},
      rpc:async()=>({data:{ready:false,reserve_count:0,
        reserve_count_by_question:Object.fromEntries(completed.questions.map(question=>[question.id,0]))},error:null}),
      from(table){
        calls.push(table);
        const filters=[];
        const values=table==="profiles"?{role:variant==="admin"?"admin":"participant",status:variant==="inactive"?"deactivated":"active"}:
          table==="sessions"?(variant==="foreign"?null:{status:"in_progress",requested_question_count:3}):
            table==="questions"?completed.questions.map(question=>({id:question.id,slot_index:question.slot_index,question_text:question.question_text,
              status:question.status,regeneration_index:question.regeneration_index})):
              table==="session_images"?[{id:imageId,storage_path:`${owner}/${sessionId}/test.png`,sort_order:0,width:1200,height:800}]:
                table==="question_targets"?completed.questions.flatMap(question=>question.targets.map(target=>({question_id:question.id,...target}))):[];
        const q={select(){return q;},eq(...args){filters.push(args);return q;},in(...args){filters.push(args);return q;},abortSignal(){return q;},order(){return q;},limit(){return q;},
          maybeSingle:async()=>({data:values,error:variant==="db-error"?{code:"PRIVATE"}:null}),
          then(resolve){const data=table==="questions"&&filters.some(([column,value])=>
            column==="question_kind"&&value==="followup")?[]:values;return Promise.resolve({data,error:null}).then(resolve);}};
        return q;
      },
      storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:"https://private-test.supabase.co/storage/v1/object/sign/why-box-images/test"},error:null})})},
    };
    const scoped=loader({
      "@/lib/supabase/server":{createSupabaseServerClient:async()=>caller},
      "@/lib/supabase/admin":{createSupabaseAdminClient:()=>{throw new Error("TRUSTED WRITE FORBIDDEN");}},
      "@/lib/ai/server/question-generation-service":{
        ...load("src/lib/ai/server/question-generation-service.ts"),
        runQuestionGeneration:()=>{throw new Error("GENERATION FORBIDDEN");},
      },
    });
    const {GET}=scoped("src/app/api/question-generation/route.ts");
    const response=await GET(new NextRequest(`http://localhost/api/question-generation?session_id=${variant==="bad-id"?"bad":sessionId}`));
    assert.equal(response.headers.get("Cache-Control"),"no-store");
    const body=await response.json();
    if(variant==="valid") assert.deepEqual(body,view("completed"));
    else {assert.ok(response.status>=400);assert.doesNotMatch(JSON.stringify(body),/PRIVATE|TEST question/);}
    if(["anonymous","admin","inactive"].includes(variant)) assert.ok(!calls.includes("sessions"));
  }
});

test("question count server action validates bounds/auth and uses caller ownership/state guarded update",async()=>{
  for(const variant of ["valid","bad-count","bad-session","anonymous","admin","inactive","locked","db-error"]) {
    const updates=[],filters=[],activities=[],errors=[];
    const caller={
      auth:{getUser:async()=>({data:{user:variant==="anonymous"?null:{id:"TEST-owner"}},error:null})},
      from(table){
        const q={select(){return q;},update(value){updates.push(value);return q;},
          eq(...args){filters.push(args);return q;},in(...args){filters.push(args);return q;},
          maybeSingle:async()=>({
            data:table==="profiles"?{role:variant==="admin"?"admin":"participant",status:variant==="inactive"?"deactivated":"active"}:
              variant==="locked"?null:{requested_question_count:5},
            error:variant==="db-error"?{code:"42501"}:null,
          })};
        return q;
      },
    };
    const {saveQuestionCount}=loader({
      "@/lib/supabase/server":{createSupabaseServerClient:async()=>caller},
      "@/lib/errors/report":{reportError:async(...args)=>{errors.push(args);return {message:"TEST safe failure"};}},
      "@/lib/activity/record":{recordParticipantActivity:async kind=>{activities.push(kind);return true;}},
    })("src/app/(participant)/sessions/[sessionId]/context-actions.ts");
    const result=await saveQuestionCount(variant==="bad-session"?"bad":sessionId,variant==="bad-count"?6:5);
    assert.equal(result.success,variant==="valid");
    if(variant==="valid") {
      assert.deepEqual(updates,[{requested_question_count:5}]);
      assert.ok(filters.some(f=>f[0]==="participant_id"&&f[1]==="TEST-owner"));
      assert.ok(filters.some(f=>f[0]==="status"&&JSON.stringify(f[1])==='["draft","question_generation"]'));
      assert.deepEqual(activities,["context_saved"]);
    } else {assert.equal(activities.length,0);assert.ok(errors.length>0);}
  }
});

test("server page renders the saved result in completed and in-progress sessions without entering the wizard",async()=>{
  const {QuestionResult}=loader({
    "next/link":{default:({children,...p})=>React.createElement("a",p,children)},
    "next/navigation":{useRouter:()=>({push(){}})},
  })(
    "src/app/(participant)/sessions/[sessionId]/question-result.tsx");
  const readCalls=[];
  for(const status of ["completed","in_progress"]) {
    const {default:Page}=loader({
      "@/lib/auth/role":{requireRole:async()=>({user:{id:randomUUID()},supabase:{
        from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({
          data:{status,summary_text:"TEST final summary"},error:null,
        })}),
      }})},
      "@/lib/question-generation/read":{readGenerationView:async()=>{readCalls.push(status);return view("completed");}},
      "./session-wizard":{SessionWizard:()=>{throw new Error("WIZARD FORBIDDEN");}},
      "./question-result":{QuestionResult},
      "../../activity-marker":{ActivityMarker:()=>null},
      "next/link":{default:({children,...p})=>React.createElement("a",p,children)},
      "next/navigation":{notFound:()=>{throw new Error("NOT FOUND");}},
    })("src/app/(participant)/sessions/[sessionId]/page.tsx");
    const element=await Page({params:Promise.resolve({sessionId}),searchParams:Promise.resolve({})});
    const html=renderToStaticMarkup(element);
    assert.doesNotMatch(html,/질문 생성하기/);
    if(status==="completed") {
      assert.match(html,/디자인 브리핑/);
      assert.doesNotMatch(html,/디자인 브리핑 요약 보기/);
      assert.match(html,/저장된 디자인 브리핑을 불러오고 있어요/);
      assert.doesNotMatch(html,/TEST final summary/);
    }
    else {
      assert.match(html,/생각을 돌아보는 질문/);
      assert.doesNotMatch(html,/생각을 넓히는 질문/);
      assert.match(html,/TEST question 1/);assert.match(html,/나의 생각/);
    }
  }
  assert.deepEqual(readCalls,["completed","in_progress"]);
});

test("session completion blocks unprocessed questions without issuing a completion request",async(t)=>{
  const calls=[];
  const ui=await mountResult(t,view("completed"),async(url,options={})=>{
    calls.push({url,options});
    throw new Error("Unexpected network request");
  });
  await act(async()=>{
    ui.host.querySelector(".question-result-footer .wizard-actions > button").click();
    await settle();
  });
  const confirm=[...ui.host.querySelectorAll(".session-finish-dialog button")]
    .find(button=>button.textContent.trim()==="세션 종료");
  assert.ok(confirm);
  assert.equal(ui.host.querySelector("#session-finish-title").textContent,"세션을 종료할까요?");
  assert.equal([...ui.host.querySelectorAll(".session-finish-dialog button")]
    .some(button=>button.textContent.trim()==="계속 작성"),true);
  assert.equal(ui.host.querySelector(".session-finish-dialog p").innerHTML.includes("<br>"),true);
  assert.match(readFileSync("src/app/globals.css","utf8"),
    /\.session-finish-dialog \.session-dialog-actions > button \{ flex:1 1 0; min-width:0; white-space:nowrap; \}/);
  await act(async()=>{confirm.click();await settle();});
  assert.match(ui.host.querySelector(".completion-status").textContent,/각 질문에 답하거나 건너뛰어야/);
  assert.equal(ui.host.querySelectorAll(".completion-missing-questions button").length,3);
  assert.equal(calls.filter(call=>call.url.endsWith("/complete")).length,0);
});

for (const mode of ["mock","openai"]) {
test(`session completion accepts saved answers and skipped questions, deduplicates clicks and loads the ${mode} briefing`,async(t)=>{
  const input=view("completed");
  input.questions=input.questions.map((question,index)=>({
    ...question,
    status:index===0?"unprocessed":"skipped",
    answer:{...question.answer,original_answer:index===0?"Synthetic design answer":""},
  }));
  const requests=[];
  const ui=await mountResult(t,input,async(url,options={})=>{
    if(url.endsWith("/complete")) {
      const body=JSON.parse(options.body);
      requests.push(body);
      return json({
        request_id:body.request_id,state:"completed",attempt_number:1,
        retry_of_request_id:body.retry_of_request_id,missing_question_ids:[],
        has_answer:true,replayed:false,provider_mode:mode,
      });
    }
    if(url.endsWith("/briefing")) {
      const body=briefingBody();
      if(mode==="openai")body.source.model_id="mocked-production-model";
      return json(body);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  await act(async()=>{
    ui.host.querySelector(".question-result-footer .wizard-actions > button").click();
    await settle();
  });
  const confirm=[...ui.host.querySelectorAll(".session-finish-dialog button")]
    .find(button=>button.textContent.trim()==="세션 종료");
  assert.ok(confirm);
  await act(async()=>{confirm.click();confirm.click();await settle();});
  assert.equal(requests.length,1);
  assert.match(requests[0].request_id,/^[0-9a-f-]{36}$/i);
  assert.equal(requests[0].retry_of_request_id,null);
  assert.equal(ui.host.querySelector(".briefing-text").textContent,"Synthetic design briefing");
  assert.match(ui.host.querySelector(".briefing-provenance").textContent,
    mode==="mock"?/TEST용 Mock 브리핑/:/AI 생성 브리핑/);
  const copied=[];
  let rejectClipboard=false;
  Object.defineProperty(ui.dom.window.navigator,"clipboard",{configurable:true,value:{
    async writeText(text) { if(rejectClipboard)throw new Error("clipboard denied"); copied.push(text); },
  }});
  await act(async()=>{
    ui.host.querySelector('[aria-label="현재 브리핑 복사"]').click();
    await settle();
  });
  assert.deepEqual(copied,["Synthetic design briefing"]);
  assert.equal(ui.host.querySelector(".toast-box").textContent,"디자인 브리핑 전체를 복사했어요.");
  rejectClipboard=true;
  await act(async()=>{
    ui.host.querySelector('[aria-label="현재 브리핑 복사"]').click();
    await settle();
  });
  assert.match(ui.host.querySelector(".toast-box.toast-error").textContent,/클립보드에 복사하지 못했습니다/);
  assert.equal(ui.host.querySelector('[aria-label="질문 1 위치 보기"]').textContent,"1");
  await act(async()=>{
    ui.host.querySelector('[aria-label="질문 1 선택"]').click();
    await settle();
  });
  assert.equal(ui.host.querySelector("textarea").disabled,true);
});
}

test("ambiguous session completion exposes recovery and retries only the same request when selected",async(t)=>{
  const input=view("completed");
  input.questions=input.questions.map((question,index)=>({
    ...question,
    status:index===0?"unprocessed":"skipped",
    answer:{...question.answer,original_answer:index===0?"Synthetic design answer":""},
  }));
  const requests=[];
  const ui=await mountResult(t,input,async(url,options={})=>{
    if(url.endsWith("/complete")) {
      requests.push(JSON.parse(options.body));
      if(requests.length===1)throw new Error("Synthetic ambiguous response");
      const body=requests.at(-1);
      return json({
        request_id:body.request_id,state:"completed",attempt_number:1,
        retry_of_request_id:null,missing_question_ids:[],has_answer:true,replayed:true,provider_mode:"mock",
      });
    }
    if(url.endsWith("/briefing"))return json(briefingBody());
    throw new Error(`Unexpected request: ${url}`);
  });
  await act(async()=>{
    ui.host.querySelector(".question-result-footer .wizard-actions > button").click();
    await settle();
  });
  const confirm=[...ui.host.querySelectorAll(".session-finish-dialog button")]
    .find(button=>button.textContent.trim()==="세션 종료");
  assert.ok(confirm);
  await act(async()=>{confirm.click();await settle();});
  assert.equal(requests.length,1);
  assert.match(ui.host.querySelector(".completion-status").textContent,/같은 요청의 상태만 확인/u);
  assert.ok(ui.host.querySelector(".completion-status.is-recovery"));
  assert.match(readFileSync("src/app/globals.css","utf8"),
    /\.completion-status\.is-recovery \{ text-align:center; \}/);
  const check=[...ui.host.querySelectorAll(".completion-status button")]
    .find(button=>button.textContent.trim()==="같은 요청 결과 확인");
  assert.ok(check);
  await act(async()=>{check.click();await settle();});
  assert.equal(requests.length,2);
  assert.equal(requests[1].request_id,requests[0].request_id);
  assert.equal(ui.host.querySelector(".briefing-text").textContent,"Synthetic design briefing");
});

test("completion enters the briefing view even when the saved briefing read fails, then allows read retry",async(t)=>{
  const input=view("completed");
  input.questions=input.questions.map((question,index)=>({
    ...question,status:index===0?"unprocessed":"skipped",
    answer:{...question.answer,original_answer:index===0?"Synthetic design answer":""},
  }));
  let reads=0;
  const ui=await mountResult(t,input,async(url,options={})=>{
    if(url.endsWith("/complete")) {
      const body=JSON.parse(options.body);
      return json({request_id:body.request_id,state:"completed",attempt_number:1,
        retry_of_request_id:null,missing_question_ids:[],has_answer:true,replayed:false,provider_mode:"mock"});
    }
    if(url.endsWith("/briefing")) {
      reads++;
      return reads===1?json({errorCode:"COMPLETION-DB"},503):json(briefingBody());
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  await act(async()=>{
    ui.host.querySelector(".question-result-footer .wizard-actions > button").click();
    await settle();
  });
  const confirm=[...ui.host.querySelectorAll(".session-finish-dialog button")]
    .find(button=>button.textContent.trim()==="세션 종료");
  await act(async()=>{confirm.click();await settle();});
  assert.equal(reads,1);
  assert.ok(ui.host.querySelector(".briefing-panel"));
  assert.match(ui.host.querySelector(".briefing-notice").textContent,/브리핑을 불러오지 못했습니다/u);
  const retry=[...ui.host.querySelectorAll(".briefing-panel button")]
    .find(button=>button.textContent.trim()==="다시 불러오기");
  assert.ok(retry);
  await act(async()=>{retry.click();await settle();});
  assert.equal(reads,2);
  assert.equal(ui.host.querySelector(".briefing-text").textContent,"Synthetic design briefing");
});

test("summary-ready sessions remain read-only without prematurely reading or exposing a briefing",async(t)=>{
  let reads=0;
  const ui=await mountResult(t,view("completed"),async(url)=>{
    assert.match(url,/\/api\/sessions\/.*\/briefing$/);
    reads++;
    return json(briefingBody("Saved synthetic briefing"));
  },"summary_ready");
  assert.equal(reads,0);
  assert.equal(ui.host.querySelector(".briefing-text"),null);
  assert.equal(ui.host.querySelector(".question-result-footer .wizard-actions > button"),null);
  assert.equal(ui.host.querySelector('[aria-label="디자인 브리핑 요약 보기"]'),null);
  await act(async()=>{
    ui.host.querySelector('[aria-label="질문 1 선택"]').click();
    await settle();
  });
  assert.equal(ui.host.querySelector("textarea").disabled,true);
});

  test("question generation transitions from stale server status into editable questions without refresh or briefing GET",async(t)=>{
    const ui=await mount(t,{sessionStatus:"question_generation"});
    await ui.click(ui.button("질문 생성하기"));
    assert.equal(ui.host.querySelector('[aria-label="디자인 브리핑 요약 보기"]'),null);
    assert.equal(ui.host.querySelector('[aria-label="나의 생각"]').disabled,false);
    await ui.click(ui.host.querySelector('[aria-label="질문 2 선택"]'));
    assert.match(ui.host.querySelector(".question-panel-text").textContent,/TEST question 2/);
    assert.equal(ui.host.querySelector('[aria-label="나의 생각"]').disabled,false);
    assert.equal(ui.calls.some(c=>String(c.url).endsWith("/briefing")),false);
    assert.equal(ui.calls.filter(c=>c.url==="/api/question-generation"&&c.opts.method==="POST").length,1);
  });

  test("pin bubble closes without deselecting, reopens on same pin, and switches exact question",async(t)=>{
    const ui=await mountResult(t);
    const pin=n=>ui.host.querySelector(`[aria-label="질문 ${n} 위치 보기"]`);
    await act(async()=>{pin(1).click();await settle();});
    assert.equal(ui.host.querySelector(".question-bubble p").textContent,"TEST question 1");
    assert.equal(pin(1).getAttribute("aria-expanded"),"true");
    await act(async()=>{ui.host.querySelector(".question-bubble-close").click();await settle();});
    assert.equal(ui.host.querySelector(".question-bubble"),null);
    assert.equal(pin(1).getAttribute("aria-current"),"true");
    await act(async()=>{pin(1).click();await settle();});
    assert.equal(ui.host.querySelector(".question-bubble p").textContent,"TEST question 1");
    await act(async()=>{pin(2).click();await settle();});
    assert.equal(ui.host.querySelector(".question-bubble p").textContent,"TEST question 2");
    assert.equal(ui.host.querySelector(".question-panel-text").textContent,"TEST question 2");
    await act(async()=>{ui.host.querySelector('[aria-label="질문 3 선택"]').click();await settle();});
    assert.equal(ui.host.querySelector(".question-bubble"),null);
  });

test("display pin layout separates dense mobile targets without mutating persisted coordinates",()=>{
  const {layoutQuestionPins}=load("src/lib/question-generation/pin-layout.ts");
  const original=[
    {id:"q1",slot:1,x:.50,y:.50},
    {id:"q3",slot:3,x:.505,y:.51},
    {id:"q5",slot:5,x:.495,y:.49},
    {id:"edge1",slot:2,x:0,y:0},
    {id:"edge2",slot:4,x:.01,y:.01},
  ];
  const before=structuredClone(original);
  for(const frame of [
    {name:"390px mobile",width:308,height:231},
    {name:"tablet",width:560,height:420},
    {name:"PC",width:900,height:675},
  ]) {
    const displayed=layoutQuestionPins(frame,original);
    assert.equal(displayed.length,original.length);
    for(const pin of displayed) {
      assert.ok(pin.left>=19&&pin.left<=frame.width-19);
      assert.ok(pin.top>=19&&pin.top<=frame.height-19);
    }
    for(let i=0;i<displayed.length;i++)for(let j=i+1;j<displayed.length;j++)
      assert.ok(Math.hypot(displayed[i].left-displayed[j].left,displayed[i].top-displayed[j].top)>=43.99,
        `${frame.name} pins ${displayed[i].id}/${displayed[j].id} overlap`);
    const moved=displayed.filter(pin=>Math.hypot(pin.left-pin.originalX,pin.top-pin.originalY)>3);
    const maxDrift=Math.max(0,...displayed.map(pin=>Math.hypot(pin.left-pin.originalX,pin.top-pin.originalY)));
    assert.ok(moved.length<=original.length);
    assert.ok(maxDrift<=frame.width*.25,`${frame.name} connector length ${maxDrift}px is excessive`);
  }
  assert.deepEqual(original,before);
});

test("dense displayed pins track responsive image sizes and still select their own questions",async t=>{
  const input=view("completed",5);
  for(const [index,x] of [.5,.505,.495,.51,.49].entries()) {
    input.questions[index].targets[0].x=x;
    input.questions[index].targets[0].y=[.5,.51,.49,.495,.505][index];
  }
  const storedTargets=structuredClone(input.questions.map(question=>question.targets));
  const ui=await mountResult(t,input);
  const frame=ui.host.querySelector(".question-image-frame");
  let width=308,height=231;
  Object.defineProperties(frame,{clientWidth:{configurable:true,get:()=>width},
    clientHeight:{configurable:true,get:()=>height}});
  const resize=async()=>act(async()=>{
    for(const observer of ui.observers)if(observer.active)observer.callback();
    await settle();
  });
  await resize();
  const readPositions=()=>[...ui.host.querySelectorAll(".question-image-pins > button.question-pin:not(.question-whole-image-pin)")]
    .map(button=>({button,left:parseFloat(button.style.left),top:parseFloat(button.style.top)}));
  const mobile=readPositions();
  for(let i=0;i<mobile.length;i++)for(let j=i+1;j<mobile.length;j++)
    assert.ok(Math.hypot(mobile[i].left-mobile[j].left,mobile[i].top-mobile[j].top)>=43.99);
  const movedCount=mobile.filter(({button,left,top})=>{
    const target=input.questions[Number(button.textContent)-1].targets[0];
    return Math.hypot(left-(target.x+target.width/2)*width,top-(target.y+target.height/2)*height)>3;
  }).length;
  assert.equal(ui.host.querySelectorAll(".question-pin-connectors line").length,movedCount);
  width=560;height=420;
  await resize();
  const tablet=readPositions();
  assert.ok(tablet.some((pin,index)=>pin.left!==mobile[index].left||pin.top!==mobile[index].top));
  width=900;height=675;
  await resize();
  const desktop=readPositions();
  assert.ok(desktop.every(pin=>pin.left>=19&&pin.left<=width-19&&pin.top>=19&&pin.top<=height-19));
  assert.deepEqual(input.questions.map(question=>question.targets),storedTargets);
  for(const question of input.questions) {
    const pin=ui.host.querySelector(`[aria-label="질문 ${question.slot_index} 위치 보기"]`);
    await act(async()=>{pin.click();await settle();});
    assert.equal(ui.host.querySelector(".question-bubble")?.getAttribute("aria-label"),
      `질문 ${question.slot_index} 말풍선`);
    assert.equal(ui.host.querySelector(`[aria-label="질문 ${question.slot_index} 위치 보기"]`)
      .getAttribute("aria-current"),"true");
  }
});

test("bubble chooses an in-frame position that avoids nearby pin hit areas when possible",()=>{
  const {bubblePosition}=load("src/lib/question-generation/bubble-position.ts");
  for(const frame of [{width:308,height:231},{width:560,height:420},{width:900,height:675}]) {
    for(const pin of [
      {left:0,right:38,top:0,bottom:38},
      {left:frame.width/2-19,right:frame.width/2+19,top:frame.height/2-19,bottom:frame.height/2+19},
      {left:frame.width-38,right:frame.width,top:frame.height-38,bottom:frame.height},
    ]) {
      const obstacles=[
        {left:frame.width/2-19,right:frame.width/2+19,top:frame.height/2-19,bottom:frame.height/2+19},
        {left:frame.width/2+25,right:frame.width/2+63,top:frame.height/2-19,bottom:frame.height/2+19},
      ];
      const bubble=bubblePosition(frame,pin,80,obstacles);
      assert.ok(bubble.left>=0&&bubble.top>=0);
      assert.ok(bubble.left+bubble.width<=frame.width);
      assert.ok(bubble.top+bubble.maxHeight<=frame.height);
      assert.ok(obstacles.every(obstacle=>bubble.left+bubble.width<=obstacle.left||
        bubble.left>=obstacle.right||bubble.top+bubble.maxHeight<=obstacle.top||
        bubble.top>=obstacle.bottom));
    }
  }
});

  test("failed completion retains question selection and answers without exposing or fetching briefing",async(t)=>{
    const input=view("completed");
    input.questions=input.questions.map((q,index)=>({...q,status:index===0?"answered":"skipped",
      answer:{...q.answer,original_answer:index===0?"Saved synthetic answer":""}}));
    let briefingReads=0;
    const ui=await mountResult(t,input,async(url,options={})=>{
      if(url.endsWith("/briefing")){briefingReads++;return json({errorCode:"BRIEFING-NOT-FOUND"},404);}
      if(url.endsWith("/complete"))return json({request_id:JSON.parse(options.body).request_id,state:"failed",
        attempt_number:1,retry_of_request_id:null,missing_question_ids:[],has_answer:true,replayed:false,provider_mode:"openai"},502);
      throw new Error("Unexpected request");
    });
    await act(async()=>{ui.host.querySelector(".question-result-footer .wizard-actions button").click();await settle();});
    await act(async()=>{[...ui.host.querySelectorAll(".session-finish-dialog button")].find(b=>b.textContent==="세션 종료").click();await settle();});
    assert.equal(briefingReads,0);
    assert.equal(ui.host.querySelector('[aria-label="디자인 브리핑 요약 보기"]'),null);
    assert.equal(ui.host.querySelector('[aria-label="나의 생각"]').value,"Saved synthetic answer");
    assert.equal(ui.host.querySelector('[aria-label="나의 생각"]').disabled,true);
    assert.match(ui.host.querySelector(".completion-status").textContent,/브리핑 생성을 완료하지 못했습니다/);
  });
test("briefing CAS conflicts preserve the participant draft instead of replacing it",async(t)=>{
  const ui=await mountResult(t,view("completed"),async(url,options={})=>{
    if(options.method==="PATCH")return json({errorCode:"BRIEFING-REVISION-CONFLICT",current_revision:2},409);
    return json(briefingBody("Stored synthetic briefing",1));
  },"completed");
  await act(async()=>{
    ui.host.querySelector(".briefing-edit-button").click();
    await settle();
  });

  const editor=ui.host.querySelector("#design-briefing-editor");
  Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype,"value")
    .set.call(editor,"Participant's unsaved synthetic draft");
  await act(async()=>{
    editor.dispatchEvent(new ui.dom.window.Event("input",{bubbles:true}));
    await settle();
  });
  await act(async()=>{
    [...ui.host.querySelectorAll("button")].find(button=>button.textContent.trim()==="저장").click();
    await settle();
  });
  assert.equal(ui.host.querySelector("#design-briefing-editor").value,"Participant's unsaved synthetic draft");
  assert.match(ui.host.querySelector(".briefing-notice").textContent,/최신 revision 2/);
  assert.ok([...ui.host.querySelectorAll("button")].some(button=>button.textContent.includes("최신 버전 불러오기")));
});

test("pin bubble recalculates bounded coordinates after image resize and ancestor zoom",async(t)=>{
  const ui=await mountResult(t);
  const frame=ui.host.querySelector(".question-image-frame");
  const pin=ui.host.querySelector('[aria-label="질문 1 위치 보기"]');
  let width=400,height=300,scale=1;
  Object.defineProperties(frame,{clientWidth:{get:()=>width},clientHeight:{get:()=>height}});
  frame.getBoundingClientRect=()=>({left:100,top:100,width:width*scale,height:height*scale});
  pin.getBoundingClientRect=()=>({left:100+(width*.175-19)*scale,right:100+(width*.175+19)*scale,
    top:100+(height*.26-19)*scale,bottom:100+(height*.26+19)*scale});
  await act(async()=>{pin.click();await settle();});
  const bubble=()=>ui.host.querySelector(".question-bubble");
  const initialLeft=bubble().style.left,initialTop=bubble().style.top;
  scale=2;
  await act(async()=>{for(const o of ui.observers)if(o.active)o.callback();await settle();});
  assert.equal(bubble().style.left,initialLeft);
  assert.equal(bubble().style.top,initialTop);
  width=200;height=150;
  await act(async()=>{for(const o of ui.observers)if(o.active)o.callback();await settle();});
  assert.ok(parseFloat(bubble().style.left)+parseFloat(bubble().style.width)<=width);
  assert.ok(parseFloat(bubble().style.top)+parseFloat(bubble().style.maxHeight)<=height);
  await ui.close();
  assert.ok(ui.observers.every(o=>!o.active));
});

test("internal navigation offers continue or save-and-leave without completing the session",async(t)=>{
  const requests=[];
  const ui=await mountResult(t,view("completed"),async(url,options={})=>{
    requests.push({url,options});
    throw new Error("Unexpected API request");
  });
  ui.dom.window.history.replaceState({}, "","/sessions/"+sessionId);
  await act(async()=>{
    ui.host.querySelector('a[href="/history"]').click();
    await settle();
  });
  assert.ok(ui.host.querySelector('[role="dialog"]'));
  const exitDialog=ui.host.querySelector(".session-exit-dialog");
  assert.equal(exitDialog.querySelector("p").innerHTML.includes("<br>"),false);
  assert.equal(exitDialog.querySelectorAll("button").length,2);
  assert.doesNotMatch(exitDialog.textContent,/세션 종료를 선택하면 브리핑 생성이 시작됩니다/);
  assert.match(readFileSync("src/app/globals.css","utf8"),
    /\.session-exit-dialog \{ text-align:center; \}/);
  assert.match(readFileSync("src/app/globals.css","utf8"),
    /\.session-exit-dialog \.session-dialog-actions \{ justify-content:center; \}/);
  assert.match(readFileSync("src/app/globals.css","utf8"),
    /\.session-exit-dialog \.session-dialog-actions > button \{ flex:1 1 0; min-width:0; white-space:nowrap; \}/);
  await act(async()=>{
    [...ui.host.querySelectorAll(".session-exit-dialog button")]
    .find(button=>button.textContent.trim()==="계속 작성").click();
    await settle();
  });
  assert.equal(ui.host.querySelector('[role="dialog"]'),null);
  await act(async()=>{
    ui.host.querySelector('a[href="/history"]').click();
    await settle();
  });
  await act(async()=>{
    [...ui.host.querySelectorAll(".session-exit-dialog button")]
    .find(button=>button.textContent.trim()==="저장 후 나가기").click();
    await settle();
  });
  assert.deepEqual(ui.router.pushes,["/history"]);
  assert.equal(requests.length,0);
});

test("client POST deadline and failed GET preserve locked recovery with no automatic retry",async(t)=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  let posts=0;const states=[];
  const c=new GenerationController(view(),()=>true,s=>states.push(s),async(_session,_id,signal)=>{
    posts++;return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new Error("TEST transport timeout")),{once:true}));
  },async()=>{throw new Error("PRIVATE read error");});
  c.attach();const first=c.start();t.mock.timers.tick(GENERATION_REQUEST_MS);await first;
  assert.equal(posts,1);assert.equal(states.at(-1).view.state,"recovery");
  assert.doesNotMatch(states.at(-1).message,/PRIVATE/);
  await c.start();assert.equal(posts,1);c.detach();await settle();
});

test("context edits and saved snapshot survive a visible loading-to-failed transition without new autosaves",async(t)=>{
  const pending=deferred();
  const ui=await mount(t,{postResult:async()=>{await pending.promise;return json({errorCode:"QGEN-API"},502);},
    readResult:req=>({...view(),failed_request_id:req})});
  const textarea=ui.host.querySelector("textarea");
  await act(async()=>{
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype,"value").set.call(textarea,"TEST latest saved edit");
    textarea.dispatchEvent(new ui.dom.window.Event("input",{bubbles:true}));await settle();
    await new Promise(r=>setTimeout(r,1010));await settle();
  });
  assert.equal(ui.saves.length,1);assert.equal(ui.button("질문 생성하기").disabled,false);
  await ui.click(ui.button("질문 생성하기"));
  assert.ok(ui.host.querySelector(".loading-state-overlay"));
  assert.equal(textarea.disabled,true);
  await act(async()=>{pending.resolve();await settle();});
  assert.equal(textarea.disabled,false);assert.equal(textarea.value,"TEST latest saved edit");
  assert.equal(ui.button("질문 생성하기").disabled,false);
  await act(async()=>{await new Promise(r=>setTimeout(r,10));await settle();});
  assert.equal(ui.saves.length,1);
});
