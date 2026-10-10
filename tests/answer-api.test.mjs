import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { URL } from "node:url";
import ts from "typescript";

const require=createRequire(import.meta.url);
function loader(overrides={}) {
  const cache=new Map();
  function load(path) {
    const url=path instanceof URL?path:new URL(`../${path}`,import.meta.url);
    if(cache.has(url.href))return cache.get(url.href);
    const module={exports:{}};
    const compiled=ts.transpileModule(readFileSync(url,"utf8"),{compilerOptions:{
      module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,
    }}).outputText;
    runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
      name=>Object.hasOwn(overrides,name)?overrides[name]:name==="server-only"?{}:
        name.startsWith("@/")?load(`src/${name.slice(2)}.ts`):
          name.startsWith(".")?load(new URL(`${name}.ts`,url)):require(name),module,module.exports);
    cache.set(url.href,module.exports);
    return module.exports;
  }
  return load;
}
const questionId="50000000-0000-4000-8000-000000000001";
const answer=(overrides={})=>({
  question_id:questionId,original_answer:"TEST original",refined_answer:null,refinement_used:false,
  current_answer_version:"original",updated_at:"2026-10-08T11:00:00.000Z",...overrides,
});
const response=(url,body)=>new (require("next/server").NextRequest)(`http://localhost${url}`,{
  method:"POST",headers:{origin:"http://localhost",host:"localhost","x-forwarded-proto":"http",
    "content-type":"application/json"},
  body:JSON.stringify(body),
});
const answerError=class AnswerError extends Error {
  constructor(code,status=503){super(code);this.code=code;this.status=status;}
};

function routeLoader({current=answer(),saveResult,editable=true,participant=true,refined="TEST refined",refineHook,readHook,editableHook,configHook}={}) {
  const calls={writes:[],activity:[],refine:[],filters:[]};
  const helpers={
    AnswerError:answerError,
    requireActiveParticipant:async()=>{
      if(!participant)throw new answerError("ANSWER-AUTH",403);
      return "10000000-0000-4000-8000-000000000001";
    },
    requireEditableQuestion:async()=>{
      if(editableHook)await editableHook();
      if(!editable)throw new answerError("ANSWER-AUTH",403);
    },
    readAnswer:async()=>readHook?readHook():current,
  };
  const caller={from(table) {
    let changes=null;
    const query={
      update(value){changes=value;return query;},
      insert(value){changes=value;return query;},
      eq(column,value){calls.filters.push([column,value]);return query;},
      abortSignal(){return query;},
      select(){return query;},
      maybeSingle:async()=>{
        calls.writes.push({table,changes});
        if(saveResult instanceof Error)return {data:null,error:saveResult};
        if(saveResult===null)return {data:null,error:null};
        return {data:saveResult??{current_answer_version:changes?.current_answer_version??"original",
          updated_at:"2026-10-08T11:01:00.000Z"},error:null};
      },
    };
    return query;
  }};
  const load=loader({
    "@/lib/supabase/server":{createSupabaseServerClient:async()=>caller},
    "@/lib/activity/record":{recordParticipantActivity:async(...args)=>{calls.activity.push(args);return true;}},
    "@/lib/answers/server":helpers,
    "@/lib/ai/server/sentence-refinement-config":{
      SENTENCE_REFINEMENT_TIMEOUT_MS:60_000,sentenceRefinementConfig:()=>configHook?configHook():({apiKey:"mock-only",model:"mock-model"}),
    },
    "@/lib/ai/server/sentence-refinement":{
      refineSentence:async(config,text,signal)=>{calls.refine.push({config,text});return refineHook?refineHook(signal):refined;},
    },
  });
  return {load,calls};
}

test("answer save validates origin, strict input, participant ownership and compare-and-set revision",async()=>{
  const {load,calls}=routeLoader();
  const {POST}=load("src/app/api/question-answer/route.ts");
  const saved=await POST(response("/api/question-answer",{
    question_id:questionId,answer_text:"TEST changed",answer_version:"original",
    expected_updated_at:"2026-10-08T11:00:00.000Z",
  }));
  assert.equal(saved.status,200);
  assert.deepEqual(calls.writes[0],{table:"answers",changes:{original_answer:"TEST changed",current_answer_version:"original"}});
  assert.equal(calls.activity.length,1);
  assert.equal(saved.headers.get("Cache-Control"),"no-store");
  const stale=await POST(response("/api/question-answer",{
    question_id:questionId,answer_text:"TEST stale",answer_version:"original",expected_updated_at:null,
  }));
  assert.equal(stale.status,409);
  assert.equal((await stale.json()).errorCode,"ANSWER-STALE");
  const injected=await POST(response("/api/question-answer",{
    question_id:questionId,answer_text:"TEST",answer_version:"original",
    expected_updated_at:"2026-10-08T11:00:00.000Z",model:"attacker-model",
  }));
  assert.equal(injected.status,400);
  const wrongOrigin=response("/api/question-answer",{
    question_id:questionId,answer_text:"TEST",answer_version:"original",
    expected_updated_at:"2026-10-08T11:00:00.000Z",
  });
  wrongOrigin.headers.set("origin","https://attacker.invalid");
  assert.equal((await POST(wrongOrigin)).status,403);
  const denied=routeLoader({participant:false});
  const deniedResponse=await denied.load("src/app/api/question-answer/route.ts").POST(response("/api/question-answer",{
    question_id:questionId,answer_text:"TEST",answer_version:"original",
    expected_updated_at:"2026-10-08T11:00:00.000Z",
  }));
  assert.equal(deniedResponse.status,403);
  assert.equal(denied.calls.writes.length,0);
});

test("PostgreSQL offset revisions retain microseconds across reads, save and refinement contracts",async()=>{
  const load=loader();
  const {answerRevisionSchema}=load("src/lib/answers/revision.ts");
  const {answerRowSchema}=load("src/lib/answers/server.ts");
  const {sentenceRefinementRequestSchema,sentenceRefinementResultSchema}=
    load("src/lib/ai/sentence-refinement-contract.ts");
  for(const revision of ["2026-10-08T11:00:00.123456+00:00","2026-10-08T20:00:00.123456+09:00",
    "2026-10-08T11:00:00.123456Z"]) {
    assert.equal(answerRevisionSchema.parse(revision),revision);
    assert.equal(answerRowSchema.parse(answer({updated_at:revision})).updated_at,revision);
    assert.equal(sentenceRefinementRequestSchema.parse({
      question_id:questionId,expected_updated_at:revision,
    }).expected_updated_at,revision);
    assert.equal(sentenceRefinementResultSchema.parse({
      refined_text:"TEST refined",updated_at:revision,
    }).updated_at,revision);
    const routes=routeLoader({current:answer({updated_at:revision})});
    const result=await routes.load("src/app/api/question-answer/route.ts").POST(response("/api/question-answer",{
      question_id:questionId,answer_text:"TEST original",answer_version:"original",expected_updated_at:revision,
    }));
    assert.equal(result.status,200);
    assert.equal((await result.json()).updated_at,revision);
    assert.equal(routes.calls.writes.length,0);
    const stale=await routes.load("src/app/api/question-answer/route.ts").POST(response("/api/question-answer",{
      question_id:questionId,answer_text:"TEST changed",answer_version:"original",
      expected_updated_at:revision.replace("123456","123455"),
    }));
    assert.equal(stale.status,409);
    assert.equal(routes.calls.writes.length,0);
    const refined=await routes.load("src/app/api/sentence-refinement/route.ts").POST(
      response("/api/sentence-refinement",{question_id:questionId,expected_updated_at:revision}));
    assert.equal(refined.status,200);
    assert.equal(routes.calls.refine.length,1);
  }
  for(const invalid of ["not-a-date","2026-10-08T11:00:00","2026-99-99T11:00:00+00:00"]) {
    assert.equal(answerRevisionSchema.safeParse(invalid).success,false);
  }
});

test("new answer inserts only authored fields and refined edits never overwrite the original",async()=>{
  const fresh=routeLoader({current:null});
  const result=await fresh.load("src/app/api/question-answer/route.ts").POST(response("/api/question-answer",{
    question_id:questionId,answer_text:"TEST new original",answer_version:"original",expected_updated_at:null,
  }));
  assert.equal(result.status,200);
  assert.deepEqual(fresh.calls.writes[0],{table:"answers",changes:{
    question_id:questionId,participant_id:"10000000-0000-4000-8000-000000000001",
    original_answer:"TEST new original",
  }});
  const refined=routeLoader({current:answer({
    refined_answer:"TEST refined",refinement_used:true,current_answer_version:"refined",
  })});
  const saved=await refined.load("src/app/api/question-answer/route.ts").POST(response("/api/question-answer",{
    question_id:questionId,answer_text:"TEST edited refined",answer_version:"refined",
    expected_updated_at:"2026-10-08T11:00:00.000Z",
  }));
  assert.equal(saved.status,200);
  assert.deepEqual(refined.calls.writes[0],{table:"answers",changes:{
    refined_answer:"TEST edited refined",current_answer_version:"refined",
  }});
  const invalid=await fresh.load("src/app/api/question-answer/route.ts").POST(response("/api/question-answer",{
    question_id:"invalid",answer_text:"TEST invalid",answer_version:"original",expected_updated_at:null,
  }));
  assert.equal(invalid.status,400);assert.equal(fresh.calls.writes.length,1);
});

test("answer access helpers require an active participant, editable owned session and valid answer row",async()=>{
  const helpers=loader()("src/lib/answers/server.ts");
  const queries=[];
  const callerFor=(profile,question,session)=>{
    const caller={
      auth:{getUser:async()=>({data:{user:{id:"10000000-0000-4000-8000-000000000001"}},error:null})},
      from(table) {
        const filters=[];queries.push({table,filters});
        const query={
          select(){return query;},eq(...value){filters.push(value);return query;},
          abortSignal(){return query;},
          maybeSingle:async()=>({data:table==="profiles"?profile:table==="questions"?question:session,error:null}),
        };
        return query;
      },
    };
    return caller;
  };
  const signal=new globalThis.AbortController().signal;
  const owner="10000000-0000-4000-8000-000000000001";
  const question={id:questionId,session_id:"20000000-0000-4000-8000-000000000001",
    status:"unprocessed",is_active_version:true,question_kind:"original"};
  const caller=callerFor({role:"participant",status:"active"},question,{status:"in_progress"});
  assert.equal(await helpers.requireActiveParticipant(caller,signal),owner);
  assert.deepEqual(await helpers.requireEditableQuestion(caller,owner,questionId,signal),
    {session_id:question.session_id});
  assert.ok(queries.find(item=>item.table==="sessions").filters.some(([column,value])=>
    column==="participant_id"&&value===owner));
  await assert.rejects(helpers.requireActiveParticipant(
    callerFor({role:"participant",status:"deactivated"},question,{status:"in_progress"}),signal),
  error=>error.code==="ANSWER-AUTH");
  await assert.rejects(helpers.requireEditableQuestion(
    callerFor({role:"participant",status:"active"},question,null),owner,questionId,signal),
  error=>error.code==="ANSWER-AUTH");
  for(const state of ["draft","completed","summary_ready","generating"]) {
    await assert.rejects(helpers.requireEditableQuestion(
      callerFor({role:"participant",status:"active"},question,{status:state}),owner,questionId,signal),
    error=>error.code==="ANSWER-STATE");
  }
  await assert.rejects(helpers.requireEditableQuestion(
    callerFor({role:"participant",status:"active"},null,{status:"in_progress"}),owner,questionId,signal),
  error=>error.code==="ANSWER-AUTH");
  await assert.rejects(helpers.requireEditableQuestion(
    callerFor({role:"participant",status:"active"},{...question,status:"skipped"},{status:"in_progress"}),
    owner,questionId,signal),error=>error.code==="ANSWER-STATE");
  const validRow=answer();
  assert.deepEqual(await helpers.readAnswer({
    from:()=>({select(){return this;},eq(){return this;},abortSignal(){return this;},
      maybeSingle:async()=>({data:validRow,error:null})}),
  },questionId,signal),validRow);
});

test("sentence refinement ignores client answer/model overrides and persists only validated server output",async()=>{
  const {load,calls}=routeLoader();
  const {POST}=load("src/app/api/sentence-refinement/route.ts");
  const result=await POST(response("/api/sentence-refinement",{
    question_id:questionId,expected_updated_at:"2026-10-08T11:00:00.000Z",
  }));
  assert.equal(result.status,200);
  assert.deepEqual(calls.refine,[{config:{apiKey:"mock-only",model:"mock-model"},text:"TEST original"}]);
  assert.deepEqual(calls.writes.at(-1),{table:"answers",changes:{
    refined_answer:"TEST refined",refinement_used:true,refined_at:calls.writes.at(-1).changes.refined_at,
    current_answer_version:"refined",
  }});
  assert.equal(calls.activity.length,1);
  const injected=await POST(response("/api/sentence-refinement",{
    question_id:questionId,expected_updated_at:"2026-10-08T11:00:00.000Z",
    answer_text:"UNTRUSTED",model:"attacker-model",prompt:"attacker prompt",
  }));
  assert.equal(injected.status,400);
  const denied=routeLoader({editable:false});
  const deniedResult=await denied.load("src/app/api/sentence-refinement/route.ts")
    .POST(response("/api/sentence-refinement",{
      question_id:questionId,expected_updated_at:"2026-10-08T11:00:00.000Z",
    }));
  assert.equal(deniedResult.status,403);
  assert.equal(denied.calls.refine.length,0);
  const stale=routeLoader({current:answer({updated_at:"2026-10-08T11:05:00.000Z"})});
  const staleResult=await stale.load("src/app/api/sentence-refinement/route.ts")
    .POST(response("/api/sentence-refinement",{
      question_id:questionId,expected_updated_at:"2026-10-08T11:00:00.000Z",
    }));
  assert.equal(staleResult.status,409);
  assert.equal(stale.calls.refine.length,0);
});

test("sentence refinement provider uses one non-stored Responses request without SDK retries",async()=>{
  const providerCalls={clientOptions:null,parameters:null,options:null};
  class MockOpenAI {
    static APIError=class APIError extends Error {};
    static APIConnectionTimeoutError=class APIConnectionTimeoutError extends Error {};
    constructor(options){providerCalls.clientOptions=options;this.responses={create:async(parameters,optionsValue)=>{
      providerCalls.parameters=parameters;providerCalls.options=optionsValue;
      return {status:"completed",output:[{type:"message",role:"assistant",status:"completed",content:[
        {type:"output_text",text:"TEST sentence"},
      ]}]};
    }};}
  }
  const load=loader({openai:{default:MockOpenAI}});
  const provider=load("src/lib/ai/server/sentence-refinement.ts");
  const text=await provider.refineSentence({apiKey:"mock-only",model:"mock-model"},"TEST original",
    new globalThis.AbortController().signal);
  assert.equal(text,"TEST sentence");
  assert.equal(providerCalls.clientOptions.maxRetries,0);
  assert.equal(providerCalls.parameters.model,"mock-model");
  assert.equal(providerCalls.parameters.store,false);
  assert.match(providerCalls.parameters.instructions,/전문적인 문장으로 정돈하세요/);
  assert.match(providerCalls.parameters.instructions,/불확실성, 미결정 상태, 근거 부족을 확신이나 완료된 판단으로 바꾸지 마세요/);
  assert.equal(providerCalls.parameters.input[0].content[0].text,"TEST original");
  assert.deepEqual(Object.keys(providerCalls.options),["signal"]);
  assert.ok(providerCalls.options.signal instanceof globalThis.AbortSignal);
});

test("sentence refinement v1.1 prompt preserves uncertainty and limits professionalization to a Mock contract",async()=>{
  const load=loader();
  const original=load("src/lib/ai/prompts/sentence-refinement-v1.0.ts").SENTENCE_REFINEMENT_PROMPT;
  const updated=load("src/lib/ai/prompts/sentence-refinement-v1.1.ts").SENTENCE_REFINEMENT_PROMPT;
  assert.match(original,/의미 보존/);
  assert.match(original,/새로운 사실이나 사용자가 표현하지 않은 의도도 추가하지 마세요/);
  for(const clause of [
    /사용자의 감정, 불확실성, 추측, 유보와 확신의 정도를 바꾸지 마세요/,
    /디자인 의사결정과 검토 과정을 설명하는 데 적합한 자연스럽고 전문적인 문장/,
    /사용자가 실제로 고민하거나 비교 중이라고 말한 경우에만/,
    /불확실성, 미결정 상태, 근거 부족을 확신이나 완료된 판단으로 바꾸지 마세요/,
    /사용자가 언급하지 않은 디자인 의도, 검토 과정, 판단 근거, 전문 용어를 새로 만들어내지 마세요/,
    /이미 충분히 자연스럽고 전문적인 문장은 억지로 바꾸지 마세요/,
    /짧은 답변은 원문과 비슷한 길이로 간결하게 유지/,
  ])assert.match(updated,clause);
  assert.notEqual(updated,original);

  const scenarios=[
    ["잘 모르겠음","아직 구체적인 방향을 정하지 못한 상태이다."],
    ["색상은 아직 잘 모르겠어서 고민 중이다.","색상 방향은 현재 여러 가능성을 고려하며 검토 중이다."],
    ["그냥 예뻐 보여서 이렇게 했다.","시각적인 인상을 고려하여 해당 표현 방식을 선택했다."],
    ["이게 맞는지 모르겠다.","현재 선택한 방향의 적절성을 추가로 검토할 필요가 있다."],
    ["별생각 없이 배치했다.","배치의 구체적인 의도와 근거는 아직 정리되지 않은 상태이다."],
    ["버튼 간격은 16px로 설정했다.","버튼 간격은 16px로 설정했다."],
    ["잘 모르겠다.","아직 구체적인 방향을 정하지 못했다."],
  ];
  let activeScenario;
  const requests=[];
  class MockOpenAI {
    static APIError=class APIError extends Error {};
    static APIConnectionTimeoutError=class APIConnectionTimeoutError extends Error {};
    constructor(){this.responses={create:async(parameters)=>{
      requests.push(parameters);
      return {status:"completed",output:[{type:"message",role:"assistant",status:"completed",content:[
        {type:"output_text",text:activeScenario[1]},
      ]}]};
    }};}
  }
  const provider=loader({openai:{default:MockOpenAI}})("src/lib/ai/server/sentence-refinement.ts");
  for(const scenario of scenarios) {
    activeScenario=scenario;
    const refined=await provider.refineSentence({apiKey:"mock-only",model:"mock-model"},scenario[0],
      new globalThis.AbortController().signal);
    assert.equal(refined,scenario[1]);
    const request=requests.at(-1);
    assert.equal(request.instructions,updated);
    assert.equal(request.input[0].content[0].text,scenario[0]);
    assert.equal(request.store,false);
  }
  assert.equal(requests.length,scenarios.length);
});

test("sentence refinement config is explicitly disabled by default and output rejects refusals/incomplete results",()=>{
  const load=loader();
  const config=load("src/lib/ai/server/sentence-refinement-config.ts");
  assert.throws(()=>config.sentenceRefinementConfig({
    OPENAI_API_KEY:"mock-only",OPENAI_SENTENCE_REFINEMENT_MODEL:"mock-model",
  }),error=>error.code==="REFINE-CONFIG");
  assert.throws(()=>config.sentenceRefinementConfig({
    OPENAI_SENTENCE_REFINEMENT_ENABLED:"true",OPENAI_API_KEY:"mock-only",
  }),error=>error.code==="REFINE-CONFIG");
  assert.deepEqual(config.sentenceRefinementConfig({
    OPENAI_SENTENCE_REFINEMENT_ENABLED:"true",OPENAI_API_KEY:"mock-only",
    OPENAI_SENTENCE_REFINEMENT_MODEL:"mock-model",
  }),{apiKey:"mock-only",model:"mock-model"});
  const {extractRefinedSentence}=load("src/lib/ai/server/sentence-refinement.ts");
  assert.throws(()=>extractRefinedSentence({status:"completed",output:[{type:"message",role:"assistant",status:"completed",
    content:[{type:"refusal",refusal:"TEST refusal"}]}]}),error=>error.code==="REFINE-REFUSAL");
  assert.throws(()=>extractRefinedSentence({status:"incomplete",output:[]}),
    error=>error.code==="REFINE-INCOMPLETE");
  assert.throws(()=>extractRefinedSentence({status:"completed",output:[{type:"message",role:"assistant",status:"completed",
    content:[{type:"output_text",text:"```markdown\nTEST```"}]}]}),error=>error.code==="REFINE-OUTPUT");
});

const refinementInput={question_id:questionId,expected_updated_at:"2026-10-08T11:00:00.000Z"};
const refinedResponse=text=>({status:"completed",output:[{
  type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text}],
}]});

test("mock refinement keeps short, long, misspelled, natural, uncertain and design-term originals",async()=>{
  for(const [original,refined] of [
    ["버튼이 작다.","버튼이 작다."],
    ["긴 문장입니다. ".repeat(900),"긴 문장입니다. ".repeat(900).trim()],
    ["참여자 관리를 할수잇을 것 같아요.","참여자 관리를 할 수 있을 것 같아요."],
    ["정보 구조가 명확하다고 생각합니다.","정보 구조가 명확하다고 생각합니다."],
    ["잘 모르겠는데 아마 중요할 것 같아요.","잘 모르겠지만, 아마 중요할 것 같아요."],
    ["CTA와 affordance가 좀 애매한 것 같아요.","CTA와 affordance가 조금 애매한 것 같아요."],
  ]) {
    const current=answer({original_answer:original});
    const route=routeLoader({current,refined});
    const result=await route.load("src/app/api/sentence-refinement/route.ts").POST(
      response("/api/sentence-refinement",refinementInput));
    assert.equal(result.status,200);
    assert.equal((await result.json()).refined_text,refined);
    assert.equal(route.calls.refine[0].text,original);
    assert.equal(current.original_answer,original);
    assert.equal(Object.hasOwn(route.calls.writes[0].changes,"original_answer"),false);
    assert.equal(route.calls.writes[0].changes.refined_answer,refined);
  }
});

test("refinement preconditions prevent provider calls for empty, oversized, disabled and completed answers",async()=>{
  let SentenceRefinementError;
  for(const [options,code,status] of [
    [{current:answer({original_answer:" \n "})},"REFINE-EMPTY",422],
    [{current:answer({original_answer:"a".repeat(20_001)})},"REFINE-INPUT",400],
    [{configHook:()=>{throw new SentenceRefinementError("REFINE-CONFIG");}},"REFINE-CONFIG",503],
    [{editableHook:()=>{throw new answerError("ANSWER-STATE",409);}},"REFINE-STATE",409],
    [{participant:false},"REFINE-AUTH",403],
  ]) {
    const route=routeLoader(options);
    SentenceRefinementError=route.load("src/lib/ai/sentence-refinement-contract.ts").SentenceRefinementError;
    const result=await route.load("src/app/api/sentence-refinement/route.ts").POST(
      response("/api/sentence-refinement",refinementInput));
    assert.equal(result.status,status);assert.equal((await result.json()).errorCode,code);
    assert.equal(route.calls.refine.length,0);assert.equal(route.calls.writes.length,0);
  }
});

test("refinement concurrent identical requests coalesce one provider call and one write",async()=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const route=routeLoader({refineHook:()=>pending});
  const {POST}=route.load("src/app/api/sentence-refinement/route.ts");
  const first=POST(response("/api/sentence-refinement",refinementInput));
  const second=POST(response("/api/sentence-refinement",refinementInput));
  await new Promise(resolve=>globalThis.setTimeout(resolve,10));
  assert.equal(route.calls.refine.length,1);
  release("TEST shared refined");
  const results=await Promise.all([first,second]);
  assert.deepEqual(await results[0].json(),await results[1].json());
  assert.equal(route.calls.writes.length,1);assert.equal(route.calls.activity.length,1);
});

test("process-local flight rejects another revision, isolates questions and releases failures",async()=>{
  const {runSentenceRefinement}=loader()("src/lib/ai/server/sentence-refinement-flight.ts");
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const first=runSentenceRefinement("TEST user","TEST question","revision-1",()=>pending);
  assert.throws(()=>runSentenceRefinement("TEST user","TEST question","revision-2",()=>pending),
    error=>error.code==="REFINE-BUSY");
  const other=await runSentenceRefinement("TEST user","TEST other question","revision-1",
    async()=>({refined_text:"TEST isolated",updated_at:"TEST revision"}));
  assert.equal(other.refined_text,"TEST isolated");
  release({refined_text:"TEST first",updated_at:"TEST revision"});await first;
  await assert.rejects(runSentenceRefinement("TEST user","TEST question","revision-2",
    async()=>{throw new Error("TEST failure");}));
  assert.equal((await runSentenceRefinement("TEST user","TEST question","revision-2",
    async()=>({refined_text:"TEST retried",updated_at:"TEST revision"}))).refined_text,"TEST retried");
});

test("refining selected refined text targets only the same question and revision without changing original",async()=>{
  const original="TEST untouched original";
  const current=answer({original_answer:original,refined_answer:"TEST selected refined",
    refinement_used:true,current_answer_version:"refined"});
  const route=routeLoader({current});
  const result=await route.load("src/app/api/sentence-refinement/route.ts").POST(
    response("/api/sentence-refinement",refinementInput));
  assert.equal(result.status,200);
  assert.equal(route.calls.refine[0].text,"TEST selected refined");
  assert.deepEqual(route.calls.filters,[["question_id",questionId],["updated_at",refinementInput.expected_updated_at]]);
  assert.equal(current.original_answer,original);
  assert.equal(Object.hasOwn(route.calls.writes[0].changes,"original_answer"),false);
});

test("refinement rejects changed text/version/revision and session completion after provider response",async()=>{
  for(const variant of ["text","version","revision","completed","cas"]) {
    let reads=0,checks=0;
    const route=routeLoader({
      readHook:()=>{
        reads++;
        if(reads===1)return answer();
        return answer(variant==="text"?{original_answer:"TEST newer source"}:
          variant==="version"?{current_answer_version:"refined",refined_answer:"TEST another version",refinement_used:true}:
            variant==="revision"?{updated_at:"2026-10-08T11:02:00.000Z"}:{});
      },
      editableHook:()=>{
        if(++checks===2&&variant==="completed")throw new answerError("ANSWER-STATE",409);
      },
      saveResult:variant==="cas"?null:undefined,
    });

    const result=await route.load("src/app/api/sentence-refinement/route.ts").POST(
      response("/api/sentence-refinement",refinementInput));
    assert.equal(result.status,409);
    assert.equal((await result.json()).errorCode,variant==="completed"?"REFINE-STATE":"REFINE-STALE");
    assert.equal(route.calls.writes.length,variant==="cas"?1:0);
    assert.equal(route.calls.activity.length,0);
  }
});

test("refinement failures never overwrite originals and aborted requests do not persist",async(t)=>{
  for(const code of ["REFINE-REFUSAL","REFINE-INCOMPLETE","REFINE-OUTPUT","REFINE-TIMEOUT","REFINE-RATE","REFINE-CONFIG"]) {
    const route=routeLoader({refineHook:()=>{
      const {SentenceRefinementError}=route.load("src/lib/ai/sentence-refinement-contract.ts");
      throw new SentenceRefinementError(code);
    }});
    const result=await route.load("src/app/api/sentence-refinement/route.ts").POST(
      response("/api/sentence-refinement",refinementInput));
    assert.equal((await result.json()).errorCode,code);
    assert.equal(route.calls.writes.length,0);
  }
  for(const refined of ["", " ", "a".repeat(20_001)]) {
    const route=routeLoader({refined});
    const result=await route.load("src/app/api/sentence-refinement/route.ts").POST(
      response("/api/sentence-refinement",refinementInput));
    assert.equal((await result.json()).errorCode,"REFINE-OUTPUT");
    assert.equal(route.calls.writes.length,0);
  }
  const failed=routeLoader({saveResult:Object.assign(new Error("PRIVATE"),{code:"42501"})});
  const denied=await failed.load("src/app/api/sentence-refinement/route.ts").POST(
    response("/api/sentence-refinement",refinementInput));
  assert.equal((await denied.json()).errorCode,"REFINE-AUTH");
  assert.equal(failed.calls.activity.length,0);
  t.mock.timers.enable({apis:["setTimeout"]});
  let started;const ready=new Promise(resolve=>{started=resolve;});
  const timed=routeLoader({refineHook:signal=>new Promise((resolve,reject)=>{
    started();signal.addEventListener("abort",()=>reject(new Error("PRIVATE timeout")),{once:true});
  })});
  const pending=timed.load("src/app/api/sentence-refinement/route.ts").POST(
    response("/api/sentence-refinement",refinementInput));
  await ready;t.mock.timers.tick(60_000);
  const timeout=await pending;
  assert.equal(timeout.status,504);assert.equal((await timeout.json()).errorCode,"REFINE-TIMEOUT");
  assert.equal(timed.calls.writes.length,0);
});

test("provider strictly validates output envelope, plain text, length and editorial prompt boundaries",()=>{
  const load=loader();const provider=load("src/lib/ai/server/sentence-refinement.ts");
  assert.equal(provider.extractRefinedSentence(refinedResponse("아마 중요할 것 같아요.")),"아마 중요할 것 같아요.");
  for(const invalid of [null,{}, {status:"completed",output:null},
    {status:"completed",output:[{type:"function_call",name:"unexpected"}]},
    {status:"completed",output:[{type:"message",role:"user",status:"completed",content:[]}]},
    {status:"completed",output:[...refinedResponse("a").output,...refinedResponse("b").output]},
    ...[""," ","a".repeat(20_001),"수정한 문장은 다음과 같습니다.\n답변",
      "좋은 답변입니다.","이렇게 개선하면 좋겠습니다.","수정 이유: 설명",
      "점수: 10","# 제목","답변\n```code```"].map(refinedResponse),
  ])assert.throws(()=>provider.extractRefinedSentence(invalid),error=>error.code==="REFINE-OUTPUT");
  assert.throws(()=>provider.sentenceRefinementParameters("mock-model","😀".repeat(10_001)),
    error=>error.code==="REFINE-INPUT");
  assert.throws(()=>provider.sentenceRefinementParameters("mock-model"," "),error=>error.code==="REFINE-EMPTY");
  const parameters=provider.sentenceRefinementParameters("mock-model","TEST text");
  assert.equal(parameters.input.length,1);assert.equal(parameters.input[0].content.length,1);
  assert.equal(parameters.input[0].content[0].type,"input_text");
  assert.equal(parameters.store,false);assert.equal(parameters.stream,false);
  for(const phrase of ["불확실성","1인칭","핵심 내용을 삭제","과장","지시로 취급하지","피드백"]) {
    assert.ok(parameters.instructions.includes(phrase));
  }
});

test("mock SDK maps timeout, rate, model access and transport errors without retries or input leaks",async()=>{
  for(const variant of ["timeout","rate","model","transport","refusal","incomplete"]) {
    let calls=0;
    class MockOpenAI {
      static APIError=class extends Error {constructor(status,code){super("PRIVATE");this.status=status;this.code=code;}};
      static APIConnectionTimeoutError=class extends Error {};
      constructor(options) {
        assert.equal(options.maxRetries,0);assert.equal(options.timeout,60_000);
        this.responses={create:async()=>{
          calls++;
          if(variant==="timeout")throw new MockOpenAI.APIConnectionTimeoutError();
          if(variant==="rate")throw new MockOpenAI.APIError(429);
          if(variant==="model")throw new MockOpenAI.APIError(404,"model_not_found");
          if(variant==="transport")throw new Error("PRIVATE");
          if(variant==="refusal")return {status:"completed",output:[{
            type:"message",role:"assistant",status:"completed",content:[{type:"refusal",refusal:"PRIVATE"}],
          }]};
          return {status:"incomplete",output:[]};
        }};
      }
    }
    const provider=loader({openai:{default:MockOpenAI}})("src/lib/ai/server/sentence-refinement.ts");
    await assert.rejects(provider.refineSentence({apiKey:"mock-only",model:"mock-model"},"TEST",
      new globalThis.AbortController().signal),error=>error.code==={
      timeout:"REFINE-TIMEOUT",rate:"REFINE-RATE",model:"REFINE-CONFIG",transport:"REFINE-API",
      refusal:"REFINE-REFUSAL",incomplete:"REFINE-INCOMPLETE",
    }[variant]&&!error.message.includes("PRIVATE"));
    assert.equal(calls,1);
  }
});

const actionInput={
  session_id:"20000000-0000-4000-8000-000000000001",question_id:questionId,
  request_id:"70000000-0000-4000-8000-000000000001",action:"skip",expected_answer_revision:null,
};
function actionRoute({denied=false,sessionFound=true,capError=null,rpcError=null,changed=true,readError=false}={}) {
  const calls={trusted:0,rpc:[],activity:[]};
  const query={select(){return query;},eq(){return query;},
    maybeSingle:async()=>({data:sessionFound?{id:actionInput.session_id}:null,error:null})};
  const caller={from:()=>query,rpc:async()=>({data:{
    ready:true,reserve_count:2,reserve_count_by_question:{[questionId]:2},
  },error:capError})};
  const load=loader({
    "@/lib/supabase/server":{createSupabaseServerClient:async()=>caller},
    "@/lib/supabase/admin":{createSupabaseAdminClient:()=>{
      calls.trusted++;return {rpc:async(name,args)=>{
        calls.rpc.push({name,args});
        return {data:rpcError?null:{request_id:args.p_request_id,question_id:args.p_question_id,
          result_question_id:args.p_question_id,changed},error:rpcError};
      }};
    }},
    "@/lib/answers/server":{AnswerError:answerError,requireActiveParticipant:async()=>{
      if(denied)throw new answerError("ANSWER-AUTH",403);
      return "10000000-0000-4000-8000-000000000001";
    }},
    "@/lib/question-generation/read":{readGenerationView:async()=>{
      if(readError)throw new Error("PRIVATE read failure");return {session_id:actionInput.session_id};
    }},
    "@/lib/activity/record":{recordParticipantActivity:async(type)=>{calls.activity.push(type);return true;}},
  });
  return {POST:load("src/app/api/question-action/route.ts").POST,calls};
}

test("question action API authenticates caller, bounds input and uses only trusted atomic RPC",async()=>{
  const route=actionRoute();
  const result=await route.POST(response("/api/question-action",actionInput));
  assert.equal(result.status,200);assert.equal(result.headers.get("Cache-Control"),"no-store");
  assert.deepEqual(route.calls.rpc,[{name:"apply_question_action",args:{
    p_session_id:actionInput.session_id,p_question_id:questionId,p_request_id:actionInput.request_id,
    p_action:"skip",p_participant_id:"10000000-0000-4000-8000-000000000001",p_expected_answer_revision:null,
  }}]);
  assert.deepEqual(route.calls.activity,["question_skipped"]);
  for(const variant of ["denied","foreign","bad-id","injected","wrong-origin","too-large"]) {
    const guarded=actionRoute({denied:variant==="denied",sessionFound:variant!=="foreign"});
    const input=variant==="bad-id"?{...actionInput,question_id:"invalid"}:
      variant==="injected"?{...actionInput,participant_id:"attacker"}:
        variant==="too-large"?{...actionInput,extra:"a".repeat(5000)}:actionInput;
    const request=response("/api/question-action",input);
    if(variant==="wrong-origin")request.headers.set("origin","https://attacker.invalid");
    assert.ok((await guarded.POST(request)).status>=400);
    assert.equal(guarded.calls.trusted,0);
  }
});

test("unapplied question-action migration disables hosted mutations explicitly; unexpected catalog errors fail closed",async()=>{
  for(const code of ["PGRST202","42883","XX000"]) {
    const route=actionRoute({capError:{code,message:"PRIVATE"}});
    const result=await route.POST(response("/api/question-action",actionInput));
    assert.equal(result.status,code==="XX000"?503:409);
    assert.equal((await result.json()).errorCode,code==="XX000"?"QA-DB":"QA-UNAVAILABLE");
    assert.equal(route.calls.trusted,0);
  }
});

test("question action API classifies state, ownership, stale, reserve/limit errors without exposing DB details",async()=>{
  for(const [code,expected,status] of [
    ["42501","QA-AUTH",403],["40001","QA-STALE",409],["55000","QA-STATE",409],
    ["P0002","QA-RESERVE",409],["54000","QA-LIMIT",409],["XX000","QA-DB",503],
  ]) {
    const route=actionRoute({rpcError:{code,message:"PRIVATE question or answer content"}});
    const result=await route.POST(response("/api/question-action",actionInput));
    const body=await result.json();
    assert.equal(result.status,status);assert.equal(body.errorCode,expected);
    assert.doesNotMatch(JSON.stringify(body),/PRIVATE/);
    assert.equal(route.calls.activity.length,0);
  }
  const duplicate=actionRoute({changed:false});
  assert.equal((await duplicate.POST(response("/api/question-action",actionInput))).status,200);
  assert.equal(duplicate.calls.activity.length,0);
  const committedReadLost=actionRoute({readError:true});
  const lost=await committedReadLost.POST(response("/api/question-action",actionInput));
  assert.equal(lost.status,503);assert.equal((await lost.json()).errorCode,"QA-DB");
  assert.equal(committedReadLost.calls.rpc.length,1);
});
