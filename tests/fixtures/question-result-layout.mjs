import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import console from "node:console";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

const require=createRequire(import.meta.url);
const cache=new Map();
function load(path) {
  let url=path instanceof URL?path:new URL(`../../${path}`,import.meta.url);
  if(!existsSync(url)&&url.pathname.endsWith(".ts"))url=new URL(url.href+"x");
  if(cache.has(url.href))return cache.get(url.href);
  const module={exports:{}};
  const compiled=ts.transpileModule(readFileSync(url,"utf8"),{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,
  }}).outputText;
  runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
    name=>name==="next/navigation"?{useRouter:()=>({push(){}})}:
      name==="next/link"?{default:({children,...props})=>React.createElement("a",props,children)}:
        name.startsWith("@/")?load(`src/${name.slice(2)}.ts`):
          name.startsWith(".")?load(new URL(`${name}.ts`,url)):require(name),module,module.exports);
  cache.set(url.href,module.exports);return module.exports;
}
const {QuestionResult}=load("src/app/(participant)/sessions/[sessionId]/question-result.tsx");
const cases=[
  {name:"baseline"},
  ...["short","long"].map(question=>({name:`question-${question}`,question})),
  ...["short","long"].map(answer=>({name:`answer-${answer}`,answer})),
  ...["idle","saving","saved","save-failed","refining","refined","refinement-failed"]
    .map(status=>({name:`status-${status}`,status})),
  ...["portrait","square"].map(image=>({name:`image-${image}`,image})),
  {name:"multiple-images",multiple:true},
  ...[1,5].map(n=>({name:`questions-${n}`,n})),
  {name:"combined-long-failure",question:"long",answer:"long",status:"save-failed",image:"portrait",multiple:true,n:5},
  ...["skipped","regenerating","regenerated"].map(status=>({name:`action-${status}`,status})),
];
function render(variant) {
  const n=variant.n??3;
  const [width,height]=variant.image==="portrait"?[600,1200]:variant.image==="square"?[800,800]:[1200,800];
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#cbdde8"/><rect x="10%" y="10%" width="80%" height="80%" fill="#ffffff"/>
    <text x="20%" y="30%" font-size="36">SYNTHETIC TEST DESIGN</text></svg>`;
  const source=`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const imageId="60000000-0000-4000-8000-000000000001";
  const text=variant.question==="short"?"TEST?":variant.question==="long"?
    "TEST synthetic question with a deliberately long description. ".repeat(35):
    "TEST synthetic question: which part of this design would you improve, and why?";
  const answer=variant.answer==="short"?"TEST synthetic answer":variant.answer==="long"?"TEST synthetic answer. ".repeat(800):"";
  const result={session_id:"20000000-0000-4000-8000-000000000001",state:"completed",
    requested_question_count:n,failed_request_id:null,answer_editable:true,question_actions:{ready:true,reserve_count:5-n},
    images:[{id:imageId,sort_order:0,width,height,signed_url:source}],
    questions:Array.from({length:n},(_,i)=>({id:`50000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`,
      slot_index:i+1,question_text:text,
      status:variant.status==="skipped"?"skipped":"unprocessed",regeneration_index:variant.status==="regenerated"?1:0,
      targets:[{image_id:imageId,x:0.15+i*0.1,y:0.3,width:0.1,height:0.1,sort_order:0}],
      answer:{original_answer:answer,refined_answer:null,refinement_used:false,current_answer_version:"original",
        updated_at:answer?"2026-10-08T11:00:00.000Z":null}}))};
  if(variant.multiple)result.images.push({...result.images[0],id:"60000000-0000-4000-8000-000000000002",sort_order:1});
  const dom=new JSDOM(renderToStaticMarkup(React.createElement(QuestionResult,{result})));
  const document=dom.window.document;
  const status=document.querySelector(".question-answer-save-status");
  status.textContent=variant.status==="idle"?"":variant.status==="saving"?"저장 중":
    variant.status==="save-failed"?"저장 실패 · 입력한 내용은 유지되어 있어요.":"";
  const details=document.querySelector(".question-answer-statuses");
  if(variant.status==="regenerating") {
    document.querySelector('[aria-label="현재 질문 재생성"]').textContent="질문을 바꾸는 중...";
    for(const button of document.querySelectorAll(".question-actions button,.question-panel-navigation button,.question-pin"))
      button.disabled=true;
    document.querySelector("textarea").disabled=true;
  }
  if(variant.status==="save-failed") {
    for(const [tag,cls,text] of [["button","text-link","다시 저장"],
      ["p","question-answer-error","저장 상태가 변경되었습니다. 다시 시도해주세요."]]) {
      const node=document.createElement(tag);node.className=cls;node.textContent=text;details.append(node);
    }
  }
  if(["refining","refined","refinement-failed"].includes(variant.status)) {
    const node=document.createElement("p");node.className="question-refinement-status";node.setAttribute("role","status");
    node.textContent=variant.status==="refining"?"문장을 다듬는 중입니다.":
      variant.status==="refined"?"문장을 다듬었어요.":"문장 다듬기가 아직 활성화되지 않았거나 설정을 확인할 수 없습니다.";
    details.append(node);
    if(variant.status==="refined") {
      const undo=document.createElement("button");undo.className="text-link";undo.textContent="원문으로 되돌리기";details.append(undo);
    }
  }
  const markup=document.body.innerHTML;dom.window.close();
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>WHY BOX synthetic layout verification</title><link rel="stylesheet" href="/style.css">
    <script src="/verify.js" defer></script></head>
    <body><main style="max-width:1120px;margin:100px auto;padding:0 16px">${markup}</main></body></html>`;
}
const server=createServer((request,response)=>{
  const url=new URL(request.url,"http://127.0.0.1");
  response.setHeader("Cache-Control","no-store");
  if(url.pathname==="/style.css"){
    response.setHeader("Content-Type","text/css");
    response.end(readFileSync(new URL("../../src/app/globals.css",import.meta.url),"utf8"));return;
  }
  if(url.pathname==="/verify.js"){
    response.setHeader("Content-Type","application/javascript");
    response.end(readFileSync(new URL("./question-result-measurements.js",import.meta.url),"utf8"));return;
  }
  if(url.pathname==="/cases"){response.setHeader("Content-Type","application/json");response.end(JSON.stringify(cases));return;}
  const variant=cases.find(item=>item.name===url.searchParams.get("case"))??cases[0];
  response.setHeader("Content-Type","text/html; charset=utf-8");response.end(render(variant));
});
server.listen(4319,"127.0.0.1",()=>console.log("Synthetic layout fixture: http://127.0.0.1:4319"));
