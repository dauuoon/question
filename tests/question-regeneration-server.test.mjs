import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {typescriptLoader} from "./helpers/typescript-loader.mjs";
import {createRequire} from "node:module";
const {AbortController}=globalThis;
const {NextRequest}=createRequire(import.meta.url)("next/server");

const load=typescriptLoader();
const {QuestionActionError,questionActionCapabilitiesSchema}=load("src/lib/question-generation/actions-contract.ts");
const validation=load("src/lib/ai/server/question-regeneration-validation.ts");
const provider=load("src/lib/ai/server/question-regeneration.ts");
const config=load("src/lib/ai/server/question-regeneration-config.ts");
const service=load("src/lib/ai/server/question-regeneration-service.ts");
const input={session_id:randomUUID(),question_id:randomUUID(),request_id:randomUUID(),
  action:"regenerate",expected_answer_revision:null};
const sqlCapabilities=()=>({
  ready:true,reserve_count:2,reserve_count_by_question:{[input.question_id]:2},
  regeneration:{ready:true,calls_remaining:3,pending_request_id:null,pending_question_id:null,
    per_question:[{question_id:input.question_id,reserve_count:2}]},
});
const attempt=()=>({
  id:randomUUID(),...input,status:"reserved",root_question_id:input.question_id,slot_index:1,regeneration_index:0,
  input_snapshot:{primary_category_id:"ux_ui",subcategory_id:"web_design",other_category_text:null,
    stage_id:"idea_concept",additional_context:"합성 작업 맥락",context_ids:["visual_form"]},
  image_snapshot:[{id:randomUUID(),sort_order:0,storage_path:"synthetic-only/image.png",
    mime_type:"image/png",file_size:100,width:128,height:96}],
  exclusion_snapshot:[{id:input.question_id,question_text:"배치에 담긴 선택의 근거는 무엇인가요?"}],
});
const candidate=()=>({question:{question_text:"이 화면을 바라볼 때 본인이 아직 확신하지 못하는 부분은 무엇인가요?",
  content_principle:"사고의 자각과 외재화",question_type:"자기인식 질문",related_contexts:["visual_form"],
  answer_guides:[],target:{type:"region",image_indices:[1],region:{x:.1,y:.2,width:.3,height:.4}}}});
function memory() {
  const a=attempt(),failures=[];
  let status="reserved",calls=0,commits=0,acquired=true;
  const state=()=>({request_id:input.request_id,question_id:input.question_id,status,attempt_id:a.id,
    result_question_id:status==="committed"?a.id:null,changed:status==="committed",method:"api_generated"});
  return {failures,get calls(){return calls;},get commits(){return commits;},get status(){return status;},
    async begin(){const won=acquired;acquired=false;return {...state(),acquired:won};},
    async read(){return state();},async attempt(){return {...a,status};},async images(){return ["https://mock.invalid/image"];},
    async dispatch(){if(status!=="reserved")return false;status="dispatch_started";calls++;return true;},
    async stage(){status="staged";},async commit(){commits++;status="committed";
      return {request_id:input.request_id,question_id:input.question_id,result_question_id:a.id,changed:true};},
    async fail(id,requestId,code,unknown){failures.push({id,code,unknown});status=unknown?"outcome_unknown":"failed";},
  };
}
const deps=(generate=async()=>({output:candidate(),model:"mock-model",generatedAt:new Date().toISOString(),
  usage:{input_tokens:10,output_tokens:20}}))=>({config:()=>({apiKey:"mock-only",model:"mock-model"}),generate});

test("single question schema and provider never generate a five-candidate set; safe config is independent",()=>{
  const a=attempt(),params=provider.questionRegenerationParameters("mock-model",a,["https://mock.invalid"]);
  assert.equal(params.store,false);assert.equal(params.stream,false);
  assert.equal(params.text.format.name,"why_box_question_regeneration_v1_0");
  assert.deepEqual(params.text.format.schema.required,["question"]);
  assert.equal(params.max_output_tokens,2500);
  assert.throws(()=>config.questionRegenerationConfig({OPENAI_API_KEY:"mock-only",
    OPENAI_QUESTION_GENERATION_MODEL:"not-a-fallback"}),/QR-CONFIG/);
  assert.throws(()=>config.questionRegenerationConfig({OPENAI_API_KEY:"mock-only",
    OPENAI_QUESTION_REGENERATION_ENABLED:"true"}),/QR-CONFIG/);
  assert.equal(config.questionRegenerationEnabled({}),false);
});
test("validation screens taxonomy/context/geometry and exact or near duplicates",()=>{
  const a=attempt();
  assert.equal(validation.validateRegenerationOutput(candidate(),a).candidate.candidate_rank,1);
  for(const mutate of [
    q=>q.question.question_text=a.exclusion_snapshot[0].question_text+"  ",
    q=>q.question.target.region.width=1,
    q=>q.question.target.image_indices=[2],
    q=>q.question.related_contexts=[],
    q=>q.question.related_contexts=["problem_and_goal"],
    q=>q.question.question_type="not-in-taxonomy",
    q=>q.question.answer_guides=[""],
    q=>q.question.extra="injected",
  ]) {const q=candidate();mutate(q);assert.throws(()=>validation.validateRegenerationOutput(q,a));}
  assert.equal(validation.questionSimilarity("이 선택의 근거는 무엇인가요?","이 선택의 근거는 무엇인가요!"),1);
  assert.ok(validation.questionSimilarity("이 선택의 근거는 무엇인가요?","이 선택의 근거는 무엇인가요? 다시")>=.82);
  assert.equal(validation.questionSimilarity("가","나"),0);
});
test("capability schema accepts the exact SQL response and rejects malformed reserve counts",()=>{
  const response=sqlCapabilities();
  assert.deepEqual(questionActionCapabilitiesSchema.parse(response),response);
  assert.equal(questionActionCapabilitiesSchema.safeParse({
    ready:true,reserve_count:2,
    regeneration:response.regeneration,
  }).success,false);
  for(const reserveCount of [-1,1.5,6,"2",null]) {
    const malformed={...response,reserve_count_by_question:{[input.question_id]:reserveCount}};
    assert.equal(questionActionCapabilitiesSchema.safeParse(malformed).success,false);
  }
  assert.equal(questionActionCapabilitiesSchema.safeParse({
    ...response,reserve_count_by_question:{not_a_uuid:2},
  }).success,false);
  assert.equal(questionActionCapabilitiesSchema.safeParse({
    ...response,unexpected:true,
  }).success,false);
});
test("one admission dispatch, same-ID replay and staged recovery make no second provider call",async()=>{
  const repo=memory();let posts=0;
  const dependency=deps(async()=>{posts++;return {output:candidate(),model:"mock",generatedAt:new Date().toISOString(),usage:{input_tokens:1,output_tokens:1}};});
  await service.runQuestionRegeneration(repo,input,dependency);
  await service.runQuestionRegeneration(repo,input,dependency);
  await service.recoverQuestionRegeneration(repo,input.session_id,input.request_id);
  assert.equal(posts,1);assert.equal(repo.calls,1);assert.equal(repo.commits,1);
});
test("image failure and disabled configuration do not authorize dispatch",async()=>{
  for(const code of ["QR-CONFIG","QR-IMAGE"]) {
    const repo=memory(),dependency=deps();
    if(code==="QR-CONFIG")dependency.config=()=>{throw new QuestionActionError(code);};
    else repo.images=async()=>{throw new QuestionActionError(code);};
    await assert.rejects(service.runQuestionRegeneration(repo,input,dependency),new RegExp(code));
    assert.equal(repo.calls,0);assert.equal(repo.failures[0].unknown,false);
  }
});
test("timeout and unknown consume dispatch; failures never replace and never retry provider",async()=>{
  for(const code of ["QR-TIMEOUT","QR-OUTCOME-UNKNOWN","QR-REFUSAL","QR-INCOMPLETE","QR-VALIDATION","QR-DUPLICATE"]) {
    const repo=memory();let posts=0;
    const dependency=deps(async()=>{posts++;throw new QuestionActionError(code);});
    await assert.rejects(service.runQuestionRegeneration(repo,input,dependency),new RegExp(code));
    await assert.rejects(service.runQuestionRegeneration(repo,input,dependency));
    assert.equal(posts,1);assert.equal(repo.calls,1);assert.equal(repo.commits,0);
    assert.equal(repo.failures[0].unknown,["QR-TIMEOUT","QR-OUTCOME-UNKNOWN"].includes(code));
  }
});
test("uncertain stage/commit response recovers durable candidate without provider reissue",async()=>{
  const repo=memory(),stage=repo.stage;
  repo.stage=async(...args)=>{await stage(...args);throw new QuestionActionError("QR-RECOVERY");};
  await service.runQuestionRegeneration(repo,input,deps());
  assert.equal(repo.status,"committed");assert.equal(repo.calls,1);assert.equal(repo.failures.length,0);
});
test("SDK timeout, retry and refusal are verified with a mock client, no network",async()=>{
  const options=[],requests=[];
  class MockOpenAI {
    static APIConnectionTimeoutError=class extends Error {};
    static APIConnectionError=class extends Error {};
    constructor(value){options.push(value);this.responses={create:async(value)=>{
      requests.push(value);return {status:"completed",model:"mock",created_at:1,
        usage:{input_tokens:2,output_tokens:3},output:[{type:"message",status:"completed",
          content:[{type:"output_text",text:JSON.stringify(candidate())}]}]};
    }};}
  }
  const mock=typescriptLoader({openai:{default:MockOpenAI}});
  const result=await mock("src/lib/ai/server/question-regeneration.ts").generateRegenerationQuestion(
    {apiKey:"mock-only",model:"mock"},attempt(),["https://mock.invalid"],new AbortController().signal);
  assert.equal(options[0].maxRetries,0);assert.equal(options[0].timeout,60000);
  assert.equal(requests[0].store,false);assert.equal(result.usage.input_tokens,2);
});

function routeFixture({enabled=true,migration=true,pending=false,denied=false}={}) {
  const calls={run:0,recover:0,legacy:0};
  const capabilities=sqlCapabilities();
  if(!migration)delete capabilities.regeneration;
  const query={select(){return query;},eq(){return query;},
    maybeSingle:async()=>({data:{id:input.session_id},error:null})};
  const scope=typescriptLoader({
    "@/lib/supabase/server":{createSupabaseServerClient:async()=>({from:()=>query})},
    "@/lib/supabase/admin":{createSupabaseAdminClient:()=>({rpc:async()=>{
      calls.legacy++;return {data:{request_id:input.request_id,question_id:input.question_id,
        result_question_id:randomUUID(),changed:true},error:null};
    }})},
    "@/lib/answers/server":{AnswerError:class extends Error{},requireActiveParticipant:async()=>{
      if(denied)throw new Error("PRIVATE");return randomUUID();
    }},
    "@/lib/question-generation/actions-server":{readQuestionActionCapabilities:async()=>capabilities},
    "@/lib/ai/server/question-regeneration-config":{questionRegenerationEnabled:()=>enabled},
    "@/lib/question-generation/regeneration-repository":{createRegenerationRepository:()=>({})},
    "@/lib/ai/server/question-regeneration-service":{
      runQuestionRegeneration:async()=>{calls.run++;return state();},
      recoverQuestionRegeneration:async()=>{calls.recover++;return state();},
    },
    "@/lib/question-generation/read":{readGenerationView:async()=>({session_id:input.session_id})},
    "@/lib/activity/record":{recordParticipantActivity:async()=>true},
  });
  function state(){return pending?{request_id:input.request_id,question_id:input.question_id,
    status:"dispatch_started",attempt_id:randomUUID(),result_question_id:null,changed:false,method:"api_generated"}:
    {request_id:input.request_id,question_id:input.question_id,result_question_id:randomUUID(),changed:true};}
  const route=scope("src/app/api/question-action/route.ts");
  return {calls,route,post:()=>route.POST(new NextRequest("http://localhost:3000/api/question-action",
    {method:"POST",headers:{host:"localhost:3000",origin:"http://localhost:3000","Content-Type":"application/json"},
      body:JSON.stringify(input)})),
  get:()=>route.GET(new NextRequest(`http://localhost:3000/api/question-action?session_id=${input.session_id}&request_id=${input.request_id}`))};
}
test("enabled API route fails closed without new migration; disabled route preserves reserve RPC",async()=>{
  const missing=routeFixture({migration:false});
  assert.equal((await missing.post()).status,409);assert.equal(missing.calls.run,0);assert.equal(missing.calls.legacy,0);
  const disabled=routeFixture({enabled:false});
  assert.equal((await disabled.post()).status,200);assert.equal(disabled.calls.run,0);assert.equal(disabled.calls.legacy,1);
});
test("route pending/read recovery exposes no internal snapshot and GET never dispatches even if flag off",async()=>{
  const pending=routeFixture({pending:true});
  const result=await pending.post(),body=await result.json();
  assert.equal(result.status,202);assert.equal(body.retry_after_ms,1000);
  assert.equal(body.input_snapshot,undefined);assert.equal(result.headers.get("Cache-Control"),"no-store");
  const recovery=routeFixture({enabled:false});
  assert.equal((await recovery.get()).status,200);assert.equal(recovery.calls.recover,1);
  assert.equal(recovery.calls.run,0);assert.equal(recovery.calls.legacy,0);
  const denied=routeFixture({denied:true});
  assert.equal((await denied.get()).status,503);assert.equal(denied.calls.recover,0);
});
test("bounded provider wait rejects hanging mock independently of SDK retry behavior",async()=>{
  const controller=new AbortController();
  const waiting=service.withinRegenerationDeadline(new Promise(()=>{}),controller.signal);
  controller.abort();
  await assert.rejects(waiting,/QR-TIMEOUT/);
});
test("overlapping same-ID executions admit at most one mock dispatch and preserve pending result",async()=>{
  const repo=memory();
  let resolve,posts=0;
  const dependency=deps(async()=>{posts++;await new Promise(r=>{resolve=r;});
    return {output:candidate(),model:"mock",generatedAt:new Date().toISOString(),usage:{input_tokens:1,output_tokens:1}};});
  const first=service.runQuestionRegeneration(repo,input,dependency);
  for(let i=0;i<15;i++)await Promise.resolve();
  const second=await service.runQuestionRegeneration(repo,input,dependency);
  assert.equal(second.status,"dispatch_started");assert.equal(posts,1);
  resolve();await first;
  assert.equal(repo.calls,1);assert.equal(repo.commits,1);
});
test("uncertain dispatch acknowledgement never calls provider or refunds a durable claim",async()=>{
  const repo=memory(),dispatch=repo.dispatch;let posts=0;
  repo.dispatch=async(...args)=>{await dispatch(...args);throw new QuestionActionError("QR-RECOVERY");};
  // A database implementation derives uncertainty from its durable dispatch marker, not a client boolean.
  const fail=repo.fail;
  repo.fail=async(id,requestId,code,unknown)=>fail(id,requestId,code,unknown||repo.status==="dispatch_started");
  await assert.rejects(service.runQuestionRegeneration(repo,input,deps(async()=>{posts++;})),/QR-RECOVERY/);
  assert.equal(posts,0);assert.equal(repo.calls,1);assert.equal(repo.status,"outcome_unknown");
});
test("successful provider result without durable stage is never regenerated during recovery",async()=>{
  const repo=memory();let posts=0;
  repo.stage=async()=>{throw new QuestionActionError("QR-RECOVERY");};
  const dependency=deps(async()=>{posts++;return {output:candidate(),model:"mock",generatedAt:new Date().toISOString(),
    usage:{input_tokens:1,output_tokens:1}};});
  const pending=await service.runQuestionRegeneration(repo,input,dependency);
  assert.equal(pending.status,"dispatch_started");
  await service.runQuestionRegeneration(repo,input,dependency);
  assert.equal(posts,1);assert.equal(repo.calls,1);assert.equal(repo.commits,0);
});
