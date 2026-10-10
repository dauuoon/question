import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {URL} from "node:url";
import {typescriptLoader} from "./helpers/typescript-loader.mjs";
import {pgliteFixture,owner,candidate} from "./question-regeneration-fixture.mjs";

const load=typescriptLoader();
const {createRegenerationRepository}=load("src/lib/question-generation/regeneration-repository.ts");
const {runQuestionRegeneration,recoverQuestionRegeneration}=load("src/lib/ai/server/question-regeneration-service.ts");
const validation=load("src/lib/ai/server/question-regeneration-validation.ts");
const provenanceMigration=readFileSync(new URL("../supabase/migrations/20261010002000_regeneration_dispatch_provenance.sql",import.meta.url),"utf8");
function client(fixture,role) {
  return {rpc(name,args) {
    const promise=(async()=>{
      const catalog=await fixture.db.query(`select proargnames,oidvectortypes(proargtypes) types
        from pg_proc join pg_namespace n on n.oid=pronamespace where n.nspname='public' and proname=$1`,[name]);
      const fn=catalog.rows.find(fn=>fn.proargnames?.length===Object.keys(args).length);
      if(!fn)return {data:null,error:{code:"PGRST202"}};
      const types=fn.types.split(", ");
      const parameters=fn.proargnames.map((key,i)=>`${key} => $${i+1}::${types[i]}`);
      const values=fn.proargnames.map(key=>typeof args[key]==="object"&&args[key]!==null?JSON.stringify(args[key]):args[key]);
      try {
        await fixture.db.exec(`set role ${role};set request.jwt.claim.sub='${owner}';set request.jwt.claim.role='${role}';`);
        const result=await fixture.db.query(`select public.${name}(${parameters.join(",")}) value`,values);
        return {data:result.rows[0].value,error:null};
      } catch(error) {return {data:null,error:{code:error.code,message:error.message}};}
      finally {await fixture.db.exec("reset role;");}
    })();
    return {abortSignal(){return promise;}};
  }};
}
async function repositoryFixture(t) {
  const f=await pgliteFixture();t.after(()=>f.close());
  await f.db.exec(provenanceMigration);
  return {f,repo:createRegenerationRepository(client(f,"authenticated"),client(f,"service_role"),owner)};
}
const inputFor=(row)=>({session_id:row.session_id,question_id:row.id,request_id:randomUUID(),
  action:"regenerate",expected_answer_revision:null});
function validatedCandidate(attempt,text) {
  const value=candidate();delete value.candidate_rank;value.question_text=text;
  return validation.validateRegenerationOutput({question:value},attempt);
}
const metadata={model:"mock-model",generatedAt:"2026-10-09T15:00:00Z",usage:{input_tokens:10,output_tokens:20}};

test("actual repository and service complete single-question RPC pipeline and recover exact same request",async(t)=>{
  const {f,repo}=await repositoryFixture(t);
  const row=await f.db.query("select id,session_id from public.questions where is_active_version order by slot_index limit 1");
  const input=inputFor(row.rows[0]);
  repo.images=async()=>["https://mock.invalid/1","https://mock.invalid/2"];
  let calls=0;
  const result=await runQuestionRegeneration(repo,input,{
    config:()=>({apiKey:"mock-only",model:"mock-model"}),
    generate:async()=>{calls++;const value=candidate();delete value.candidate_rank;
      value.question_text="이 작업을 바라보는 스스로의 생각이 변화한 순간은 무엇인가요?";
      return {output:{question:value},model:"mock-model",generatedAt:"2026-10-09T15:00:00Z",
        usage:{input_tokens:10,output_tokens:20}};},
  });
  assert.equal(calls,1);assert.notEqual(result.result_question_id,input.question_id);
  const replay=await runQuestionRegeneration(repo,input,{config:()=>{throw new Error("No recall");},
    generate:async()=>{throw new Error("No provider");}});
  assert.equal(replay.result_question_id,result.result_question_id);
  const recovery=await recoverQuestionRegeneration(repo,input.session_id,input.request_id);
  assert.equal(recovery.result_question_id,result.result_question_id);
  const active=await f.db.query("select count(*)::int n from public.questions where is_active_version");
  assert.equal(active.rows[0].n,5);
  const provenance=await f.db.query("select model_id,prompt_version,similarity_threshold from question_regeneration_dispatch_metadata");
  assert.equal(provenance.rows.length,1);assert.equal(provenance.rows[0].model_id,"mock-model");
  assert.equal(provenance.rows[0].prompt_version,"question-regeneration-v1.0");
  assert.equal(Number(provenance.rows[0].similarity_threshold),.82);
  await assert.rejects(f.db.exec("delete from question_regeneration_dispatch_metadata"),/immutable/);
});
test("actual failed/unknown RPC status normalizes safely and retains dispatch provenance without a candidate",async(t)=>{
  const {f,repo}=await repositoryFixture(t);
  const row=(await f.db.query("select id,session_id from questions where is_active_version order by slot_index limit 1")).rows[0];
  const input=inputFor(row);
  repo.images=async()=>["https://mock.invalid/1","https://mock.invalid/2"];
  const {QuestionActionError}=load("src/lib/question-generation/actions-contract.ts");
  let calls=0;
  const deps={config:()=>({apiKey:"mock-only",model:"mock-failure-model"}),
    generate:async()=>{calls++;throw new QuestionActionError("QR-TIMEOUT",504);}};
  await assert.rejects(runQuestionRegeneration(repo,input,deps),/QR-TIMEOUT/);
  const state=await repo.read(input.session_id,input.request_id);
  assert.equal(state.status,"outcome_unknown");
  await assert.rejects(runQuestionRegeneration(repo,input,deps));
  assert.equal(calls,1);
  const rows=await f.db.query("select model_id,prompt_version from question_regeneration_dispatch_metadata");
  assert.equal(rows.rows[0].model_id,"mock-failure-model");
  assert.equal((await f.db.query("select count(*)::int n from question_regeneration_candidates")).rows[0].n,0);
  assert.equal((await f.db.query("select is_active_version from questions where id=$1",[input.question_id])).rows[0].is_active_version,true);
});

test("reserve success replay accepts the legacy action response without error_code",async(t)=>{
  const {f,repo}=await repositoryFixture(t);
  const row=(await f.db.query("select id,session_id from questions where is_active_version order by slot_index limit 1")).rows[0];
  const input=inputFor(row);
  await f.db.query(`insert into public.question_action_requests(session_id,participant_id,request_id,question_id,
    action,result_question_id) values($1,$2,$3,$4,'regenerate',$4)`,
  [input.session_id,owner,input.request_id,input.question_id]);

  const replay=await repo.begin(input);
  assert.equal(replay.status,"committed");
  assert.equal(replay.result_question_id,input.question_id);
  assert.equal(replay.acquired,false);
});

test("repeated identical candidate staging commits idempotently without a second provider dispatch",async(t)=>{
  const {f,repo}=await repositoryFixture(t);
  const row=(await f.db.query("select id,session_id from questions where is_active_version order by slot_index limit 1")).rows[0];
  const input=inputFor(row);
  const begin=await repo.begin(input);
  const attempt=await repo.attempt(begin.attempt_id,input.request_id);
  assert.equal(await repo.dispatch(attempt,metadata.model),true);
  const validated=validatedCandidate(attempt,"이 작업에서 아직 확인하지 못한 전제는 무엇인가요?");

  await repo.stage(attempt,validated,metadata);
  await repo.stage(attempt,validated,metadata);
  assert.equal((await f.db.query("select is_active_version from questions where id=$1",[input.question_id])).rows[0].is_active_version,true);
  const result=await repo.commit(attempt.id,input.request_id);
  assert.notEqual(result.result_question_id,input.question_id);
  const replay=await runQuestionRegeneration(repo,input,{config:()=>{throw new Error("No recall");},
    generate:async()=>{throw new Error("No provider");}});
  assert.equal(replay.result_question_id,result.result_question_id);
  assert.equal((await f.db.query("select count(*)::int n from question_regeneration_attempts where dispatched_at is not null")).rows[0].n,1);
});

test("slot and session limits stay distinct, and QA-STALE persists as QR-STALE",async(t)=>{
  const {f,repo}=await repositoryFixture(t);
  const readActive=async(slot)=> (await f.db.query(`select id,session_id from questions
    where is_active_version and slot_index=$1`,[slot])).rows[0];
  const replace=async(slot,text)=>{
    const input=inputFor(await readActive(slot));
    const begin=await repo.begin(input);
    const attempt=await repo.attempt(begin.attempt_id,input.request_id);
    assert.equal(await repo.dispatch(attempt,metadata.model),true);
    await repo.stage(attempt,validatedCandidate(attempt,text),metadata);
    return {input,result:await repo.commit(attempt.id,input.request_id)};
  };

  await replace(1,"이 결정에서 중요하게 고려한 조건은 무엇인가요?");
  await replace(1,"다른 선택을 했다면 가장 먼저 달라질 점은 무엇인가요?");
  await assert.rejects(repo.begin(inputFor(await readActive(1))),error=>{
    assert.equal(error.code,"QA-LIMIT");return true;
  });

  const thirdInput=inputFor(await readActive(2));
  const third=await repo.begin(thirdInput);
  const attempt=await repo.attempt(third.attempt_id,thirdInput.request_id);
  assert.equal(await repo.dispatch(attempt,metadata.model),true);
  await repo.fail(attempt.id,thirdInput.request_id,"QA-STALE",false);
  const failed=await repo.read(thirdInput.session_id,thirdInput.request_id);
  assert.equal(failed.failure_code,"QA-STALE");
  const stored=(await f.db.query("select error_code from question_regeneration_requests where request_id=$1",
    [thirdInput.request_id])).rows[0];
  assert.equal(stored.error_code,"QR-STALE");
  assert.equal((await f.db.query("select is_active_version from questions where id=$1",[thirdInput.question_id])).rows[0].is_active_version,true);

  await assert.rejects(repo.begin(inputFor(await readActive(3))),error=>{
    assert.equal(error.code,"QR-CALL-LIMIT");return true;
  });
  assert.equal((await f.db.query("select count(*)::int n from question_regeneration_attempts where dispatched_at is not null")).rows[0].n,3);
});
