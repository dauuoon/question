import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import ts from "typescript";
import ExcelJS from "exceljs";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
function loader(mocks = {}) {
  const cache = new Map();
  function load(path) {
    const url = path instanceof URL ? path : new URL(`../${path}`, import.meta.url);
    if (cache.has(url.href)) return cache.get(url.href);
    const js = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    const m = { exports: {} };
    runInThisContext(`(function(require,module,exports){${js}\n})`)(name =>
      Object.hasOwn(mocks, name) ? mocks[name] : name === "server-only" ? {} :
        name.startsWith("@/") ? load(`src/${name.slice(2)}.ts`) :
          name.startsWith(".") ? load(new URL(`${name}.ts`, url)) : require(name), m, m.exports);
    cache.set(url.href, m.exports); return m.exports;
  }
  return load;
}
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const time = "2026-10-11T09:00:00.000Z";
function fixture() {
  return {
    profiles: [{ id:id(1), role:"participant", account_type:"P", status:"active", participant_code:"P01", email:"NEVER_EXPORT@example.invalid" },
      { id:id(2), role:"admin", account_type:null, status:"active", participant_code:null }],
    sessions: [{ id:id(3),participant_id:id(1),status:"completed",created_at:time,updated_at:time,
      completed_at:time,primary_category_id:"ux_ui",subcategory_id:"web_design",other_category_text:null,
      stage_id:"visualization_specification",additional_context:"합성 맥락",requested_question_count:1 }],
    session_contexts: [{ id:id(4),session_id:id(3),context_id:"user_perspective" }],
    questions: [
      { id:id(5),session_id:id(3),slot_index:1,question_text:"=HYPERLINK(\"https://invalid\",\"수식\")",status:"unprocessed",
        question_kind:"original",content_principle:"reflection",detail_type:null,root_question_id:id(5),
        parent_question_id:null,regeneration_index:0,followup_index:null,is_active_version:false,skip_reason:null,
        generated_at:time,created_at:time,answered_at:null,skipped_at:null },
      { id:id(6),session_id:id(3),slot_index:1,question_text:"새 질문",status:"answered",
        question_kind:"regenerated",content_principle:"reflection",detail_type:"reason",root_question_id:id(5),
        parent_question_id:id(5),regeneration_index:1,followup_index:null,is_active_version:true,skip_reason:null,
        generated_at:time,created_at:time,answered_at:time,skipped_at:null },
    ],
    answers:[{ id:id(7),question_id:id(6),original_answer:"원문",refined_answer:"+정제본",
      current_answer_version:"refined",updated_at:"2026-10-11T10:00:00.000Z" }],
    session_briefing_sources:[{ session_id:id(3),source_text:"AI 원본",model_id:"offline-model",
      prompt_version:"v1",schema_version:"v1",generated_at:time }],
    session_briefing_versions:[{ id:id(8),session_id:id(3),revision:1,briefing_text:"수정본",edited_at:time },
      { id:id(9),session_id:id(3),revision:2,briefing_text:"최종 수정본",edited_at:time }],
    diaries:[{ id:id(10),session_id:id(3),participant_id:id(1),status:"submitted",
      experience_choices_json:["생각 정리","다른 관점"],feeling_choices_json:["흥미","도움"],
      free_text:"@합성 응답",submitted_at:time,updated_at:time }],
    question_events:[{ id:id(11),session_id:id(3),question_id:id(6),event_type:"regenerated",created_at:time }],
    session_images:[],
  };
}
function client(data, role="admin", active=true) {
  const queries=[];
  return {
    queries,
    async rpc(name, args) {
      queries.push({rpc:name,args});
      if(role!=="admin"||!active)return {data:null,error:{message:"denied"}};
      return {data: name==="admin_dashboard_read" ? legacyDashboard(data,args.p_page,args.p_filter)
        : participantResponse(data,args.p_page,args.p_filter),error:null};
    },
    auth:{ getUser:async()=>({data:{user:{id:id(2)}},error:null}) },
    from(table) {
      let rows=[...(data[table]??[])],columns="",head=false,count=false,range;
      const q={
        select(c,options={}){columns=c;head=!!options.head;count=options.count==="exact";queries.push({table,columns:c,head});return this;},
        order(){return this;},
        eq(c,v){rows=rows.filter(r=>r[c]===v);return this;},
        in(c,v){rows=rows.filter(r=>v.includes(r[c]));return this;},
        range(a,b){range=[a,b];return this;},
        maybeSingle:async()=>({data:columns==="role,status"?{role,status:active?"active":"deactivated"}:
          rows.length===1?Object.fromEntries(columns.split(",").map(k=>[k,rows[0][k]])):null,error:null}),
        then(resolve,reject){const selected=range?rows.slice(range[0],range[1]+1):rows;
          return Promise.resolve({data:head?null:selected.map(r=>
          Object.fromEntries(columns.split(",").map(k=>[k,r[k]]))),count:count?rows.length:null,error:null}).then(resolve,reject);},
      };
      return q;
    },
  };
}
// Independent oracle: the pre-RPC JavaScript read semantics, not the SQL's query plan.
function legacyDashboard(data, requestedPage, filter="P") {
  const accounts=new Map((data.profiles??[]).map(p=>[p.id,p]));
  const sessions=(data.sessions??[]).filter(s=>accounts.get(s.participant_id)?.role==="participant");
  const rows=sessions.map(s=>{
    const p=accounts.get(s.participant_id);
    const questions=(data.questions??[]).filter(q=>q.session_id===s.id);
    const active=questions.filter(q=>q.is_active_version);
    const dates=[s.updated_at,...questions.flatMap(q=>[q.created_at,q.answered_at,q.skipped_at]),
      ...(data.answers??[]).filter(a=>questions.some(q=>q.id===a.question_id)).map(a=>a.updated_at),
      ...(data.diaries??[]).filter(d=>d.session_id===s.id).map(d=>d.updated_at),
      ...(data.session_briefing_versions??[]).filter(v=>v.session_id===s.id).map(v=>v.edited_at),
      ...(data.session_images??[]).filter(i=>i.session_id===s.id).map(i=>i.created_at)].filter(Boolean);
    return {id:s.id,participant_id:s.participant_id,created_at:s.created_at,updated_at:s.updated_at,
      status:s.status,requested_question_count:s.requested_question_count,participant_code:p.participant_code,
      account_type:p.account_type,is_participant:true,
      last_activity_at:dates.sort((a,b)=>Date.parse(b)-Date.parse(a))[0],
      questions:active.length,answered:active.filter(q=>q.status==="answered").length,
      skipped:active.filter(q=>q.status==="skipped").length};
  });
  const p=rows.filter(s=>s.account_type==="P"),t=rows.filter(s=>s.account_type==="T");
  const participants=[...accounts.values()].filter(a=>a.role==="participant"&&a.account_type==="P");
  const achieved=participants.filter(a=>p.filter(s=>s.participant_id===a.id&&s.status==="completed").length>=5).length;
  const sorted=rows.filter(s=>filter==="all"||(filter==="unclassified"?s.account_type===null:s.account_type===filter))
    .sort((a,b)=>Date.parse(b.last_activity_at)-Date.parse(a.last_activity_at)||a.id.localeCompare(b.id));
  const pages=Math.max(1,Math.ceil(sorted.length/20)),page=Math.min(requestedPage,pages);
  return {research:{participants:participants.length,sessions:p.length,completed:p.filter(s=>s.status==="completed").length,
    diaries:(data.diaries??[]).filter(d=>d.status==="submitted"&&p.some(s=>s.id===d.session_id&&s.participant_id===d.participant_id)).length,
    achieved,achievementRate:participants.length?achieved/participants.length*100:0},
    service:{sessions:p.length+t.length,p:p.length,t:t.length,unclassified:rows.filter(s=>s.account_type===null).length},
    rows:sorted.slice((page-1)*20,page*20),page,pages,filter};
}
function participantResponse(data,requestedPage,filter="all") {
  const profiles=(data.profiles??[]).filter(p=>p.role==="participant"&&(filter==="all"||
    (filter==="unclassified"?p.account_type===null:p.account_type===filter)))
    .sort((a,b)=>a.participant_code.localeCompare(b.participant_code)||a.id.localeCompare(b.id));
  const pages=Math.max(1,Math.ceil(profiles.length/20)),page=Math.min(requestedPage,pages);
  return {rows:profiles.slice((page-1)*20,page*20).map(p=>({
    id:p.id,participant_code:p.participant_code,account_type:p.account_type,status:p.status??"active",
    created_at:p.created_at??time,last_activity_at:p.last_activity_at??null,
    completed:(data.sessions??[]).filter(s=>s.participant_id===p.id&&s.status==="completed").length,
    diaries:(data.diaries??[]).filter(d=>d.participant_id===p.id&&d.status==="submitted").length,
  })),page,pages,filter};
}
test("dashboard uses DB counts, excludes admin, preserves progress and sorts latest answer activity",async()=>{
  const data=fixture();
  data.sessions.push({...data.sessions[0],id:id(12),updated_at:"2026-10-11T09:30:00.000Z"});
  const {readAdminDashboard}=loader()("src/lib/admin/dashboard.ts");
  const db=client(data),result=await readAdminDashboard(db,1);
  assert.deepEqual(db.queries,[{rpc:"admin_dashboard_read",args:{p_page:1,p_filter:"P"}}]);
  assert.equal(result.research.participants,1);assert.equal(result.research.sessions,2);
  assert.equal(result.research.diaries,1);assert.deepEqual(result.service,{sessions:2,p:2,t:0,unclassified:0});
  assert.equal(result.rows[0].id,id(3));
  assert.equal(result.rows[0].questions,1);
  assert.equal(result.rows[0].answered,1);
  assert.equal(result.rows[0].participant_code,"P01");
});
test("read adapters normalize invalid pages, fail closed on RPC errors/contracts and never download tables",async()=>{
  const {readAdminDashboard}=loader()("src/lib/admin/dashboard.ts");
  const {readAdminParticipants}=loader()("src/lib/admin/participants.ts");
  for(const read of [readAdminDashboard,readAdminParticipants]) {
    for(const page of [0,-1,NaN,Infinity,1.5]) {
      const db=client(fixture());await read(db,page);
      assert.equal(db.queries.length,1);assert.equal(db.queries[0].args.p_page,1);
    }
    await assert.rejects(read({rpc:async()=>({data:null,error:{message:"private SQL error"}})},1),/RESEARCH-DB/);
    await assert.rejects(read({rpc:async()=>({data:{rows:[]},error:null})},1),/RESEARCH-DB-CONTRACT/);
    await assert.rejects(read(client(fixture(),"participant"),1),/RESEARCH-DB/);
  }
});
test("participant list retains forms, dates, research labels and filtered page links in one RPC",async()=>{
  const data=fixture();
  data.profiles=Array.from({length:25},(_,i)=>({...data.profiles[0],id:id(100+i),participant_code:`P${100+i}`}));
  data.profiles[0].id=id(1);
  const db=client(data);
  const {default:Page}=loader({
    "@/lib/auth/role":{requireRole:async()=>({supabase:db})},
    "./account-forms":{CreateParticipantForm:()=>"CREATE",ManageParticipantForm:()=>"MANAGE",ChangeAccountTypeForm:()=>"TYPE"},
    "next/link":({children,...p})=>require("react").createElement("a",p,children),
  })("src/app/(admin)/admin/participants/page.tsx");
  const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({type:"P",page:"1"})}));
  assert.match(html,/CREATE/);assert.match(html,/MANAGE/);assert.match(html,/TYPE/);
  assert.match(html,/생성일/);assert.match(html,/최근 사용일/);assert.match(html,/도구 사용 1회 · 다이어리 작성 1회/);
  assert.match(html,/최소 5회 사용 미충족/);
  assert.match(html,/href="\/admin\/participants\?type=P&amp;page=2"/);
  assert.deepEqual(db.queries,[{rpc:"admin_participants_read",args:{p_page:1,p_filter:"P"}}]);
});
test("dashboard pagination handles empty data, stable ties, and out-of-range page",async()=>{
  const {readAdminDashboard}=loader()("src/lib/admin/dashboard.ts");
  const empty=await readAdminDashboard(client({}),99);
  assert.deepEqual(empty.rows,[]);assert.equal(empty.page,1);
  const data=fixture();
  data.sessions=Array.from({length:45},(_,i)=>({...data.sessions[0],id:id(100+i)}));
  const result=await readAdminDashboard(client(data),99);
  assert.equal(result.pages,3);assert.equal(result.page,3);assert.equal(result.rows.length,5);
});
test("xlsx roundtrip retains Korean, lineage, all briefing revisions, JSON multi-choice and safe text cells",async(t)=>{
  const directory=await mkdtemp(new URL("./.admin-research-",import.meta.url).pathname);
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const db=client(fixture());
  const {writeResearchWorkbook}=loader()("src/lib/admin/research-workbook.ts");
  const file=join(directory,"test.xlsx");
  await writeResearchWorkbook(db,{kind:"sessions"},file);
  assert.ok((await stat(file)).size>0);
  const book=new ExcelJS.Workbook();await book.xlsx.readFile(file);
  assert.deepEqual(new Set(book.worksheets.map(s=>s.name)),new Set(["Sessions","Questions","Answers","Briefings","Diaries","QuestionEvents","FollowupRequests"]));
  const q=book.getWorksheet("Questions");
  assert.equal(q.rowCount,3);
  assert.equal(q.getCell("E2").type,ExcelJS.ValueType.String);
  assert.equal(q.getCell("E2").value,'=HYPERLINK("https://invalid","수식")');
  assert.equal(q.getCell("J3").value,id(5));assert.equal(q.getCell("K3").value,id(5));
  const a=book.getWorksheet("Answers");
  assert.equal(a.getCell("E2").value,"원문");assert.equal(a.getCell("F2").value,"+정제본");
  assert.equal(a.getCell("H2").value,"+정제본");
  assert.equal(a.getCell("I2").value,"2026-10-11T19:00:00.000+09:00");
  assert.equal(book.getWorksheet("Briefings").rowCount,4);
  assert.deepEqual(JSON.parse(book.getWorksheet("Diaries").getCell("E2").value),["생각 정리","다른 관점"]);
  assert.equal(book.getWorksheet("Diaries").getCell("G2").type,ExcelJS.ValueType.String);
  for(const query of db.queries)assert.doesNotMatch(query.columns.split(",")
    .filter(column=>!["input_tokens","output_tokens"].includes(column)).join(","),
  /email|password|token|api_key|storage_path/);
});

test("follow-up exports retain lineage, child answers and decision provenance without including T accounts",async t=>{
  const directory=await mkdtemp(new URL("./.admin-research-",import.meta.url).pathname);
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const data=fixture();
  data.questions.push({...data.questions[1],id:id(30),question_kind:"followup",parent_question_id:id(6),
    followup_index:1,regeneration_index:null,is_active_version:false,question_text:"후속 판단 근거는 무엇인가요?"});
  data.answers.push({...data.answers[0],id:id(31),question_id:id(30),original_answer:"후속 답변",
    refined_answer:null,current_answer_version:"original"});
  const request={
    id:id(32),session_id:id(3),participant_id:id(1),request_id:id(33),
    root_question_id:id(5),parent_question_id:id(6),expected_answer_updated_at:time,
    answer_hash:"a".repeat(64),answer_snapshot:"+정제본",status:"generated",result_question_id:id(30),
    prompt_version:"question-followup-v1.0",model_id:"offline-model",failure_code:null,
    input_tokens:123,output_tokens:45,created_at:time,dispatched_at:time,finished_at:time,
  };
  data.question_followup_requests=[request,{...request,id:id(34),request_id:id(35),status:"no_followup",result_question_id:null}];
  data.profiles.push({id:id(40),role:"participant",account_type:"T",participant_code:"T01"});
  data.sessions.push({...data.sessions[0],id:id(41),participant_id:id(40)});
  data.question_followup_requests.push({...request,id:id(42),request_id:id(43),
    session_id:id(41),participant_id:id(40),answer_snapshot:"TEST-EXCLUDED"});
  const {writeResearchWorkbook}=loader()("src/lib/admin/research-workbook.ts");
  const file=join(directory,"followups.xlsx");
  await writeResearchWorkbook(client(data),{kind:"sessions"},file);
  const book=new ExcelJS.Workbook();await book.xlsx.readFile(file);
  const requests=book.getWorksheet("FollowupRequests");
  assert.equal(requests.rowCount,3);
  assert.equal(requests.getCell("D2").value,id(5));
  assert.equal(requests.getCell("E2").value,id(6));
  assert.equal(requests.getCell("H2").value,"generated");
  assert.equal(requests.getCell("I2").value,id(30));
  assert.equal(requests.getCell("J2").value,"question-followup-v1.0");
  assert.equal(requests.getCell("M2").value,123);
  assert.equal(requests.getCell("N2").value,45);
  assert.equal(requests.getCell("H3").value,"no_followup");
  assert.equal(book.getWorksheet("Questions").getCell("G4").value,"followup");
  assert.equal(book.getWorksheet("Questions").getCell("K4").value,id(6));
  assert.equal(book.getWorksheet("Answers").getCell("E3").value,"후속 답변");
  for(const sheet of book.worksheets)for(const row of sheet.getSheetValues()) {
    assert.doesNotMatch(JSON.stringify(row)??"",/TEST-EXCLUDED|T01/);
  }
  const history=Array.from({length:1001},(_,index)=>({...request,id:id(100+index),request_id:id(2000+index),
    status:"no_followup",result_question_id:null,answer_snapshot:`Historical answer ${index}`,
    answer_hash:index.toString(16).padStart(64,"0")}));
  data.question_followup_requests.push(...history);
  const original=JSON.stringify(data);
  const historyFile=join(directory,"all-followup-history.xlsx");
  await writeResearchWorkbook(client(data),{kind:"sessions"},historyFile);
  const historyBook=new ExcelJS.Workbook();await historyBook.xlsx.readFile(historyFile);
  const historySheet=historyBook.getWorksheet("FollowupRequests");
  assert.equal(historySheet.rowCount,1004);
  assert.deepEqual(historySheet.getRow(1).values,requests.getRow(1).values);
  const exported=new Set(historySheet.getColumn("C").values);
  for(const record of history)assert.ok(exported.has(record.request_id),record.request_id);
  assert.equal(JSON.stringify(data),original);
  await assert.rejects(writeResearchWorkbook(client(data),{kind:"session",id:id(41)},
    join(directory,"test-excluded.xlsx")),/EXPORT-RESEARCH-ONLY/);
});

test("admin session detail renders T01 follow-up decisions and child answers without offering research export",async()=>{
  const data=fixture();
  data.profiles[0].account_type="T";data.profiles[0].participant_code="T01";
  data.questions.push({...data.questions[1],id:id(30),question_kind:"followup",parent_question_id:id(6),
    followup_index:1,regeneration_index:null,is_active_version:false,question_text:"합성 후속 질문"});
  data.answers.push({...data.answers[0],id:id(31),question_id:id(30),original_answer:"합성 후속 답변",
    refined_answer:null,current_answer_version:"original"});
  data.question_followup_requests=[{
    request_id:id(32),session_id:id(3),root_question_id:id(5),parent_question_id:id(6),
    answer_snapshot:"합성 판단 입력",status:"generated",result_question_id:id(30),
    prompt_version:"question-followup-v1.0",model_id:"offline-model",failure_code:null,
    input_tokens:123,output_tokens:45,created_at:time,dispatched_at:time,finished_at:time,
  }];
  data.session_briefing_requests=[];
  const page=loader({
    "@/lib/auth/role":{requireRole:async role=>{assert.equal(role,"admin");return {supabase:client(data)};}},
    "../../research-download":{ResearchDownload:()=>{throw new Error("T accounts cannot export");}},
    "next/link":{__esModule:true,default:"a"},
  })("src/app/(admin)/admin/sessions/[sessionId]/page.tsx").default;
  const html=renderToStaticMarkup(await page({params:Promise.resolve({sessionId:id(3)})}));
  for(const value of ["T01","합성 후속 질문","합성 후속 답변","합성 판단 입력","후속 질문 생성 기록",
    "question-followup-v1.0","123","45","이 세션은 연구용 Excel에서 제외됩니다"])assert.ok(html.includes(value),value);
  const headings=[...html.matchAll(/<h3>(.*?)<\/h3>/g)].map(match=>match[1]);
  assert.ok(headings.includes("슬롯 1 · 후속 질문"));
  assert.ok(headings.includes("슬롯 1 · original · 이전 버전"));
  assert.ok(headings.includes("슬롯 1 · regenerated"));
  assert.ok(headings.every(heading=>!heading.includes("후속 질문")||!heading.includes("이전 버전")));
  assert.ok(headings.every(heading=>!heading.includes("regenerated")||!heading.includes("이전 버전")));

  data.questions[1].is_active_version=false;
  const historicalHtml=renderToStaticMarkup(await page({params:Promise.resolve({sessionId:id(3)})}));
  assert.ok(historicalHtml.includes("<h3>슬롯 1 · regenerated · 이전 버전</h3>"));
  assert.ok(historicalHtml.includes("<h3>슬롯 1 · 후속 질문</h3>"));
});
test("all diary and participant/session exports respect selection and unknown records",async(t)=>{
  const directory=await mkdtemp(new URL("./.admin-research-",import.meta.url).pathname);
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const {writeResearchWorkbook}=loader()("src/lib/admin/research-workbook.ts");
  for(const kind of ["diaries","participant","session"]) {
    const file=join(directory,kind+".xlsx");
    await writeResearchWorkbook(client(fixture()),{kind,id:kind==="participant"?id(1):id(3)},file);
    const b=new ExcelJS.Workbook();await b.xlsx.readFile(file);
    assert.equal(b.getWorksheet("Diaries").rowCount,2);
    if(kind==="diaries")assert.equal(b.worksheets.length,1);
  }
  await assert.rejects(writeResearchWorkbook(client(fixture()),{kind:"participant",id:id(999)},join(directory,"bad.xlsx")),/EXPORT-RESEARCH-ONLY/);
});
test("export limits refuse overlarge cells and session counts without truncating research data",async()=>{
  const {excelText,writeResearchWorkbook}=loader()("src/lib/admin/research-workbook.ts");
  assert.throws(()=>excelText("가".repeat(32768)),/EXPORT-CELL-LIMIT/);
  const data=fixture();data.sessions=Array.from({length:2001},(_,i)=>({...data.sessions[0],id:id(i+100)}));
  await assert.rejects(writeResearchWorkbook(client(data),{kind:"sessions"},"unused.xlsx"),/EXPORT-SESSION-LIMIT/);
});
test("download endpoint rechecks active admin, rejects participant and inactive admin before reading research",async()=>{
  for(const [role,active,status] of [["participant",true,403],["admin",false,403]]) {
    const db=client(fixture(),role,active);
    const {GET}=loader({"@/lib/supabase/server":{createSupabaseServerClient:async()=>db}})("src/app/api/admin/research-export/route.ts");
    const response=await GET({nextUrl:new URL("http://localhost/api/admin/research-export?kind=sessions")});
    assert.equal(response.status,status);assert.equal(db.queries.length,1);
  }
});
test("admin download endpoint returns a valid xlsx with private no-store headers; invalid selectors are rejected",async()=>{
  const {GET}=loader({"@/lib/supabase/server":{createSupabaseServerClient:async()=>client(fixture())}})("src/app/api/admin/research-export/route.ts");
  const res=await GET({nextUrl:new URL("http://localhost/api/admin/research-export?kind=session&id="+id(3))});
  assert.equal(res.status,200);assert.match(res.headers.get("Content-Type"),/spreadsheetml/);
  assert.equal(res.headers.get("Cache-Control"),"private, no-store");
  const b=new ExcelJS.Workbook();await b.xlsx.load(Buffer.from(await res.arrayBuffer()));
  assert.equal(b.getWorksheet("Sessions").rowCount,2);
  const bad=await GET({nextUrl:new URL("http://localhost/api/admin/research-export?kind=session&id=bad")});
  assert.equal(bad.status,400);
});

test("bubble placement remains inside image for corner pins, resizing, and long questions",()=>{
  const {bubblePosition}=loader()("src/lib/question-generation/bubble-position.ts");
  for(const width of [160,320,640,1200])for(const height of [120,240,600])for(const x of [0,.5,1])for(const y of [0,.5,1]) {
    const pin={left:x*width-19,right:x*width+19,top:y*height-19,bottom:y*height+19};
    const p=bubblePosition({width,height},pin,500);
    assert.ok(p.left>=0);assert.ok(p.top>=0);
    assert.ok(p.left+p.width<=width+.001);
    assert.ok(p.top+p.maxHeight<=height+.001);
    assert.ok(p.maxHeight>=0);
  }
});

test("export anonymous auth is rejected and DB failures are explicit",async()=>{
  const db=client(fixture());
  db.auth.getUser=async()=>({data:{user:null},error:null});
  const {GET}=loader({"@/lib/supabase/server":{createSupabaseServerClient:async()=>db}})("src/app/api/admin/research-export/route.ts");
  const r=await GET({nextUrl:new URL("http://localhost/api/admin/research-export?kind=sessions")});
  assert.equal(r.status,401);assert.equal(db.queries.length,0);
  const {readResearchRows}=loader()("src/lib/admin/research-data.ts");
  const bad={from(){return {select(){return this;},order(){return this;},range:async()=>({error:{code:"failure"},data:null})};}};
  await assert.rejects(readResearchRows(bad,"sessions","id",{}),/RESEARCH-DB/);
});

test("paged research reads do not truncate after 500 records and refuse missing participant codes",async()=>{
  const {readResearchRows,profileSchema}=loader()("src/lib/admin/research-data.ts");
  const profiles=Array.from({length:1205},(_,n)=>({id:id(n+100),participant_code:`P${n+1}`}));
  const db=client({profiles});
  const rows=await readResearchRows(db,"profiles","id,participant_code",profileSchema);
  assert.equal(rows.length,1205);
  assert.equal(db.queries.length,3);
  const data=fixture();data.profiles[0].participant_code=null;
  const {readAdminDashboard}=loader()("src/lib/admin/dashboard.ts");
  await assert.rejects(readAdminDashboard(client(data),1),/RESEARCH-DB-CONTRACT/);
});

test("formula-looking text remains exact and never becomes an executable formula",()=>{
  const {excelText}=loader()("src/lib/admin/research-workbook.ts");
  for(const value of ["=1+1","+cmd","-1+2","@SUM(A1)","\t=SUM(A1)","\n=1+1","한국어"]) {
    assert.equal(excelText(value),value);
    assert.equal(typeof excelText(value),"string");
  }
});

test("all diary export preserves unsubmitted drafts instead of silently filtering research rows",async(t)=>{
  const directory=await mkdtemp(new URL("./.admin-research-",import.meta.url).pathname);
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const data=fixture();
  data.diaries.push({...data.diaries[0],id:id(99),status:"draft",submitted_at:null,free_text:"아직 작성 중"});
  const {writeResearchWorkbook}=loader()("src/lib/admin/research-workbook.ts");
  const file=join(directory,"diaries.xlsx");
  await writeResearchWorkbook(client(data),{kind:"diaries"},file);
  const book=new ExcelJS.Workbook();await book.xlsx.readFile(file);
  const sheet=book.getWorksheet("Diaries");
  assert.equal(sheet.rowCount,3);
  assert.equal(sheet.getCell("D3").value,"draft");
  assert.equal(sheet.getCell("G3").value,"아직 작성 중");
  assert.equal(sheet.getCell("H3").value,null);
});

function mixedAccounts() {
  const data=fixture();
  // Prefixes deliberately disagree with classification.
  data.profiles[0].participant_code="T99";
  data.profiles.push(
    {id:id(20),role:"participant",account_type:"T",participant_code:"P01"},
    {id:id(21),role:"participant",account_type:null,participant_code:"P09"},
    {id:id(22),role:"participant",account_type:"P",participant_code:"P02"},
    {id:id(23),role:"participant",account_type:"P",participant_code:"P03"},
    {id:id(24),role:"participant",account_type:"P",participant_code:"P04"},
  );
  const s=data.sessions[0];
  data.sessions=[];
  let n=100;
  for(const [owner,count] of [[1,4],[22,5],[23,6],[24,0],[20,8],[21,2],[2,1]]) {
    for(let j=0;j<count;j++)data.sessions.push({...s,id:id(n++),participant_id:id(owner)});
  }
  // Keep the original linked research records valid.
  data.sessions[0].id=id(3);
  data.sessions.push({...s,id:id(299),status:"draft",participant_id:id(1)},
    {...s,id:id(300),status:"in_progress",participant_id:id(1)});
  const tSession=data.sessions.find(s=>s.participant_id===id(20)).id;
  const uSession=data.sessions.find(s=>s.participant_id===id(21)).id;
  const adminSession=data.sessions.find(s=>s.participant_id===id(2)).id;
  data.diaries.push({...data.diaries[0],id:id(31),participant_id:id(20),session_id:tSession,free_text:"TEST-EXCLUDED"},
    {...data.diaries[0],id:id(32),participant_id:id(21),session_id:uSession,free_text:"UNKNOWN-EXCLUDED"},
    {...data.diaries[0],id:id(33),participant_id:id(2),session_id:adminSession,free_text:"ADMIN-EXCLUDED"});
  return {data,tSession,uSession,adminSession};
}
test("research counts use only explicit P, five completed sessions determines achievement, and P+T usage excludes unclassified",async()=>{
  const {data}=mixedAccounts();
  const {readAdminDashboard}=loader()("src/lib/admin/dashboard.ts");
  const result=await readAdminDashboard(client(data),1);
  assert.deepEqual(result.research,{participants:4,sessions:17,completed:15,diaries:1,achieved:2,achievementRate:50});
  assert.deepEqual(result.service,{sessions:25,p:17,t:8,unclassified:2});
  assert.equal(result.service.sessions,result.service.p+result.service.t);
  assert.equal(result.rows.length,17);
  assert.ok(result.rows.every(r=>r.account_type==="P"));
  const t=await readAdminDashboard(client(data),1,"T");
  assert.equal(t.rows.length,8);assert.ok(t.rows.every(r=>r.participant_code==="P01"));
  assert.deepEqual(t.research,result.research);
  const unknown=await readAdminDashboard(client(data),1,"unclassified");
  assert.equal(unknown.rows.length,2);
  const all=await readAdminDashboard(client(data),2,"all");
  assert.equal(all.pages,2);assert.equal(all.rows.length,7);assert.equal(all.filter,"all");
});
test("no P accounts yields zero research achievements and empty default recent records, not test substitutes",async()=>{
  const data=fixture();data.profiles[0].account_type="T";
  const {readAdminDashboard}=loader()("src/lib/admin/dashboard.ts");
  const result=await readAdminDashboard(client(data),1);
  assert.deepEqual(result.research,{participants:0,sessions:0,completed:0,diaries:0,achieved:0,achievementRate:0});
  assert.deepEqual(result.rows,[]);assert.equal(result.service.t,1);
});
test("every research workbook excludes T, unknown and administrator data but preserves P version history",async(t)=>{
  const {data,tSession,uSession,adminSession}=mixedAccounts();
  const directory=await mkdtemp(new URL("./.admin-research-",import.meta.url).pathname);
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const {writeResearchWorkbook}=loader()("src/lib/admin/research-workbook.ts");
  for(const kind of ["sessions","diaries","participant","session"]) {
    const file=join(directory,kind+".xlsx");
    await writeResearchWorkbook(client(data),{kind,id:kind==="participant"?id(1):id(3)},file);
    const book=new ExcelJS.Workbook();await book.xlsx.readFile(file);
    const all=JSON.stringify(book.model);
    assert.doesNotMatch(all,/TEST-EXCLUDED|UNKNOWN-EXCLUDED|ADMIN-EXCLUDED/);
    assert.ok(!all.includes(tSession));assert.ok(!all.includes(uSession));assert.ok(!all.includes(adminSession));
    if(kind!=="diaries") {
      assert.equal(book.getWorksheet("Questions").rowCount,3);
      assert.equal(book.getWorksheet("Briefings").rowCount,4);
      assert.equal(book.getWorksheet("Answers").getCell("E2").value,"원문");
      assert.equal(book.getWorksheet("Answers").getCell("F2").value,"+정제본");
    }
  }
  for(const idValue of [tSession,uSession,adminSession]) {
    await assert.rejects(writeResearchWorkbook(client(data),{kind:"session",id:idValue},join(directory,"denied.xlsx")),
      /EXPORT-RESEARCH-ONLY/);
  }
  for(const idValue of [id(20),id(21),id(2)]) {
    await assert.rejects(writeResearchWorkbook(client(data),{kind:"participant",id:idValue},join(directory,"denied.xlsx")),
      /EXPORT-RESEARCH-ONLY/);
  }
});
test("T session IDs are forbidden by the administrator HTTP export endpoint, including direct URL requests",async()=>{
  const {data,tSession}=mixedAccounts();
  const {GET}=loader({"@/lib/supabase/server":{createSupabaseServerClient:async()=>client(data)}})(
    "src/app/api/admin/research-export/route.ts");
  const response=await GET({nextUrl:new URL(`http://localhost/api/admin/research-export?kind=session&id=${tSession}`)});
  assert.equal(response.status,403);
  assert.equal((await response.json()).errorCode,"EXPORT-RESEARCH-ONLY");
});
test("empty P exports do not include T records even when T is the only account with saved research-shaped data",async(t)=>{
  const data=fixture();data.profiles[0].account_type=null;
  const directory=await mkdtemp(new URL("./.admin-research-",import.meta.url).pathname);t.after(()=>rm(directory,{recursive:true,force:true}));
  const {writeResearchWorkbook}=loader()("src/lib/admin/research-workbook.ts");
  for(const kind of ["sessions","diaries"]) {
    const file=join(directory,kind+".xlsx");await writeResearchWorkbook(client(data),{kind},file);
    const book=new ExcelJS.Workbook();await book.xlsx.readFile(file);
    assert.ok(book.worksheets.every(sheet=>sheet.rowCount===1));
  }
});
test("export fails closed if an eligible participant changes to T while the extract is generated",async(t)=>{
  const directory=await mkdtemp(new URL("./.admin-research-",import.meta.url).pathname);t.after(()=>rm(directory,{recursive:true,force:true}));
  const data=fixture(),db=client(data);
  const original=db.from.bind(db);let profileReads=0;
  db.from=table=>{
    if(table==="profiles"&&++profileReads===2)data.profiles[0].account_type="T";
    return original(table);
  };
  const {writeResearchWorkbook}=loader()("src/lib/admin/research-workbook.ts");
  await assert.rejects(writeResearchWorkbook(db,{kind:"sessions"},join(directory,"changed.xlsx")),/EXPORT-RESEARCH-ONLY/);
});

test("dashboard main research progress and auxiliary usage are separated, with persistent recent-type pagination",async()=>{
  const {data}=mixedAccounts();
  const {default:Page}=loader({
    "@/lib/auth/role":{requireRole:async role=>{assert.equal(role,"admin");return {supabase:client(data)};}},
    "./research-download":{ResearchDownload:()=>null},
    "next/link":({children,...p})=>require("react").createElement("a",p,children),
  })("src/app/(admin)/admin/page.tsx");
  const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({type:"all",page:"2"})}));
  assert.match(html,/연구 진행 현황 · P 계정만/);
  assert.match(html,/2 \/ 4명 · 50\.0%/);
  assert.match(html,/<progress[^>]*value="50"/);
  assert.match(html,/class="service-usage content-stack"/);
  assert.match(html,/실제 API 호출 횟수나 비용이 아닙니다/);
  assert.match(html,/href="\/admin\?type=all&amp;page=1"/);
  assert.match(html,/최근 세션 유형 필터/);
});
