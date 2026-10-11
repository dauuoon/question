import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { typescriptLoader } from "./helpers/typescript-loader.mjs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const { FormData } = globalThis;
const participantId = "10000000-0000-4000-8000-000000000001";
function setup({ allowed=true, profileError=null, rpcError=null, rpcData=true }={}) {
  const calls={auth:[],profiles:[],rpc:[],errors:[],paths:[],deletes:[]};
  const admin={
    auth:{admin:{
      createUser:async value=>{calls.auth.push(value);return {data:{user:{id:participantId}},error:null};},
      deleteUser:async value=>{calls.deletes.push(value);return {error:null};},
    }},
    from(table){assert.equal(table,"profiles");return {insert:async value=>{
      calls.profiles.push(value);return {error:profileError};
    }};},
  };
  const supabase={rpc:async(name,args)=>{
    calls.rpc.push({name,args});return {data:rpcData,error:rpcError};
  }};
  const load=typescriptLoader({
    "@/lib/auth/role":{requireRole:async role=>{assert.equal(role,"admin");
      if(!allowed)throw new Error("ADMIN-DENIED");return {supabase};}},
    "@/lib/supabase/admin":{createSupabaseAdminClient:()=>admin},
    "@/lib/errors/report":{reportError:async(...args)=>{
      calls.errors.push(args);return {errorCode:args[0],message:"Synthetic error"};
    }},
    "next/cache":{revalidatePath:path=>calls.paths.push(path)},
  });
  return {calls,...load("src/app/(admin)/admin/participants/actions.ts")};
}
function creation(code,type) {
  const data=new FormData();
  data.set("participant_code",code);data.set("password","synthetic-password");
  if(type!==undefined)data.set("account_type",type);return data;
}
function change({expected="",type="T",confirmed="yes",reason="E2E reviewer account"}={}) {
  const data=new FormData();
  for(const [name,value] of Object.entries({participant_id:participantId,expected_type:expected,
    account_type:type,confirmed,reason}))data.set(name,value);
  return data;
}
test("creation explicitly persists P/T independent of account code and always uses participant role",async()=>{
  for(const [code,type] of [["P01","P"],["T01","T"],["P02","T"],["T02","P"]]) {
    const s=setup();const result=await s.createParticipant({message:""},creation(code,type));
    assert.equal(result.success,true);
    assert.deepEqual(s.calls.profiles,[{id:participantId,participant_code:code,
      role:"participant",status:"active",account_type:type}]);
    assert.equal(s.calls.auth.length,1);
    assert.equal(s.calls.auth[0].email,`${code.toLowerCase()}@participants.whybox.invalid`);
    assert.ok(!Object.hasOwn(s.calls.auth[0],"role"));
  }
});
test("missing/invalid classification never creates Auth users; non-admin cannot invoke creation or type change",async()=>{
  for(const type of [undefined,"","admin","X"]) {
    const s=setup();const result=await s.createParticipant({message:""},creation("P01",type));
    assert.equal(result.errorCode,"AUTH-003");assert.equal(s.calls.auth.length,0);
  }
  const s=setup({allowed:false});
  await assert.rejects(s.createParticipant({message:""},creation("P01","P")),/ADMIN-DENIED/);
  await assert.rejects(s.changeAccountType({message:""},change()),/ADMIN-DENIED/);
  assert.equal(s.calls.auth.length,0);assert.equal(s.calls.rpc.length,0);
});
test("failed classified profile insertion retains existing compensation policy",async()=>{
  const s=setup({profileError:{code:"missing_column"}});
  const result=await s.createParticipant({message:""},creation("T01","T"));
  assert.equal(result.errorCode,"AUTH-004");assert.deepEqual(s.calls.deletes,[participantId]);
});
test("type change requires confirmation and reason, uses CAS RPC, and never changes Auth credentials",async()=>{
  for(const invalid of [{confirmed:"no"},{reason:" "},{type:"admin"},{expected:"X"}]) {
    const s=setup();const result=await s.changeAccountType({message:""},change(invalid));
    assert.equal(result.errorCode,"AUTH-003");assert.equal(s.calls.rpc.length,0);
  }
  const s=setup();const result=await s.changeAccountType({message:""},change({expected:"P",type:"T"}));
  assert.equal(result.success,true);
  assert.deepEqual(s.calls.rpc,[{name:"change_participant_account_type",args:{
    p_participant_id:participantId,p_expected_type:"P",p_account_type:"T",p_reason:"E2E reviewer account",
  }}]);
  assert.equal(s.calls.auth.length,0);assert.equal(s.calls.profiles.length,0);
  assert.ok(s.calls.paths.includes("/admin"));
});
test("conflict or malformed type-change response is explicit, with no success-shaped fallback",async()=>{
  for(const options of [{rpcError:{code:"P0001"}},{rpcData:null}]) {
    const s=setup(options);const result=await s.changeAccountType({message:""},change());
    assert.equal(result.errorCode,"AUTH-004");assert.match(result.message,/최신 유형/);
    assert.equal(result.success,undefined);
  }
  const s=setup({rpcData:false});
  assert.match((await s.changeAccountType({message:""},change())).message,/동일한 유형/);
});
test("draft migration preserves existing unclassified accounts, roles, RLS and append-only audited changes",()=>{
  const sql=readFileSync(new URL("../supabase/migrations/20261011193000_account_type_research_policy.sql",import.meta.url),"utf8");
  assert.match(sql,/^begin;/);assert.match(sql,/commit;\s*$/);
  assert.match(sql,/set local lock_timeout = '5s'/);
  assert.match(sql,/add column account_type text;/);
  assert.doesNotMatch(sql,/add column account_type.*default|update public\.profiles set account_type = 'P'/i);
  assert.match(sql,/role = 'participant' and account_type in \('P', 'T'\)/);
  assert.match(sql,/if not public\.is_active_admin\(\)/);
  assert.match(sql,/target\.role <> 'participant'/);
  assert.match(sql,/target\.account_type is distinct from p_expected_type/);
  assert.match(sql,/for update;/);
  assert.match(sql,/before update or delete/);assert.match(sql,/before truncate/);
  assert.match(sql,/enable row level security/);
  assert.match(sql,/using \(\(select public\.is_active_admin\(\)\)\)/);
  assert.match(sql,/grant execute.*change_participant_account_type[\s\S]*to authenticated/);
  assert.doesNotMatch(sql,/auth\.users|storage\.|drop policy|alter policy|disable row level|disable trigger/i);
  assert.doesNotMatch(sql,/set role\s*=|set password|delete from|truncate table/i);
  const plan=readFileSync(new URL("../supabase/operations/classify-e2e-p01.sql",import.meta.url),"utf8");
  assert.match(plan,/ec0bba1e-3720-4200-a5e1-aed0673d2c32/);
  assert.match(plan,/89507e34-b4fa-464a-b359-316be9a6bdcb/);
  assert.match(plan,/account_type is null/);
  assert.match(plan,/set participant_code = 'T01', account_type = 'T'/);
  assert.match(plan,/email = 't01@participants\.whybox\.invalid'/);
  assert.match(plan,/email_confirmed_at is not null/);
  assert.match(plan,/upper\(participant_code\) = 'T01'/);
  assert.match(plan,/auth\.identities where user_id <> target_id/);
  assert.match(plan,/affected <> 1/);
  assert.match(plan,/other_profiles_before is distinct from/);
  assert.match(plan,/target_before - 'participant_code' - 'account_type' - 'updated_at'/);
  assert.match(plan,/lock table public\.profiles in share row exclusive mode/);
  assert.match(plan,/auth_before is distinct from/);assert.match(plan,/rollback;\s*$/);
  assert.doesNotMatch(plan,/delete from|update auth\.|update public\.sessions/i);
});
test("migration preflight and postflight remain read-only and return identity checks without credential columns",()=>{
  for(const name of ["account-type-preflight","account-type-postflight"]) {
    const sql=readFileSync(new URL(`../supabase/operations/${name}.sql`,import.meta.url),"utf8");
    assert.match(sql,/begin transaction isolation level repeatable read read only;/);
    assert.match(sql,/rollback;\s*$/);
    assert.doesNotMatch(sql,/^\s*(insert|update|delete|alter|create|drop|truncate|grant|revoke|do)\b/im);
    assert.doesNotMatch(sql,/encrypted_password|raw_user_meta_data|access_token|refresh_token/);
  }
});
test("participant list offers P/T/unclassified filters and retains T detail links without claiming research achievement",async()=>{
  for(const type of ["P","T",null]) {
    const profile={id:participantId,participant_code:"P01",account_type:type,status:"active",
      created_at:"2026-10-11T10:00:00Z",last_activity_at:null,completed:6,diaries:6};
    const calls=[];
    const client={async rpc(name,args){
      calls.push({name,args});
      assert.equal(name,"admin_participants_read");assert.equal(args.p_page,1);
      const matches=args.p_filter==="all"||(args.p_filter==="unclassified"?type===null:args.p_filter===type);
      return {data:{rows:matches?[profile]:[],page:1,pages:1,filter:args.p_filter},error:null};
    }};
    const load=typescriptLoader({
      "@/lib/auth/role":{requireRole:async()=>({supabase:client})},
      "./account-forms":{CreateParticipantForm:()=>null,ManageParticipantForm:()=>null,ChangeAccountTypeForm:()=>null},
      "next/link":{default:({children,href})=>createElement("a",{href},children)},
      "@/lib/activity/screen":{formatResearchDate:()=>"-"},
    });

    const Page=load("src/app/(admin)/admin/participants/page.tsx").default;
    const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({type:type??"unclassified"})}));
    assert.match(html,/계정 유형 필터/);assert.match(html,/도구 사용 6회/);
    assert.match(html,new RegExp(`/admin/participants/${participantId}`));
    assert.match(html,type==="P"?/최소 5회 사용 충족/:/연구 달성률 집계 제외/);
    const filtered=renderToStaticMarkup(await Page({searchParams:Promise.resolve({type:type==="P"?"T":"P"})}));
    assert.doesNotMatch(filtered,/도구 사용 6회/);
    assert.deepEqual(calls.map(call=>call.args.p_filter),[type??"unclassified",type==="P"?"T":"P"]);
    assert.equal(calls.length,2);
  }
});

test("administrator session and participant details continue to show T records, while hiding research downloads",async()=>{
  const profile={id:participantId,participant_code:"P01",role:"participant",status:"active",account_type:"T"};
  const session={id:participantId,participant_id:participantId,status:"completed",created_at:"2026-10-11T10:00:00Z",
    completed_at:"2026-10-11T10:00:00Z",additional_context:"Synthetic reviewer context"};
  const client={from(table){
    const rows=table==="sessions"?[session]:table==="profiles"?[profile]:[];
    const q={select(){return this;},eq(){return this;},order(){return this;},in(){return this;},limit(){return this;},
      maybeSingle:async()=>({data:rows[0]??null,error:null}),
      then(resolve,reject){return Promise.resolve({data:rows,error:null}).then(resolve,reject);}};
    return q;
  }};
  const overrides={
    "@/lib/auth/role":{requireRole:async role=>{assert.equal(role,"admin");return {supabase:client};}},
    "next/navigation":{notFound:()=>{throw new Error("NOT-FOUND");}},
    "next/link":{default:({children,href})=>createElement("a",{href},children)},
    "../../research-download":{ResearchDownload:()=>{throw new Error("T-DOWNLOAD-FORBIDDEN");}},
    "../account-forms":{ChangeAccountTypeForm:()=>null},
  };
  const load=typescriptLoader(overrides);
  const Participant=load("src/app/(admin)/admin/participants/[participantId]/page.tsx").default;
  const p=renderToStaticMarkup(await Participant({params:Promise.resolve({participantId})}));
  assert.match(p,/T · 검토·테스트/);assert.match(p,/세션 기록/);assert.match(p,/유형 변경 이력/);
  const Session=load("src/app/(admin)/admin/sessions/[sessionId]/page.tsx").default;
  const s=renderToStaticMarkup(await Session({params:Promise.resolve({sessionId:participantId})}));
  assert.match(s,/Synthetic reviewer context/);assert.match(s,/연구용 Excel에서 제외/);
});

test("creation UI has no implicit type, and type changes expose required reason and impact confirmation",()=>{
  const load=typescriptLoader({
    react:{useActionState:(_action,state)=>[state,"/offline-action",false]},
    "./actions":{createParticipant(){},manageParticipant(){},changeAccountType(){}},
    "@/app/toast":{Toast:()=>null},
  });
  const {CreateParticipantForm,ChangeAccountTypeForm}=load("src/app/(admin)/admin/participants/account-forms.tsx");
  const create=renderToStaticMarkup(createElement(CreateParticipantForm));
  assert.match(create,/<select[^>]*name="account_type"[^>]*required/);
  assert.match(create,/<option value="" disabled="" selected=""/);
  assert.match(create,/<option value="P"/);assert.match(create,/<option value="T"/);
  const change=renderToStaticMarkup(createElement(ChangeAccountTypeForm,{id:participantId,accountType:null}));
  assert.match(change,/name="expected_type" value=""/);
  assert.match(change,/<input(?=[^>]*name="reason")(?=[^>]*required)[^>]*>/);
  assert.match(change,/<input(?=[^>]*name="confirmed")(?=[^>]*required)[^>]*>/);
  assert.match(change,/기존 기록 전체/);
});

test("P and T classification does not gate participant ownership, session creation or authorization",()=>{
  for(const path of ["src/lib/auth/role.ts","src/app/(participant)/sessions/new/actions.ts",
    "supabase/migrations/20261003201600_phase1_rls.sql"]) {
    const source=readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
    assert.doesNotMatch(source,/account_type/);
  }
});
