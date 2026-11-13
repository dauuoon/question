import test from "node:test";
import assert from "node:assert/strict";
import {typescriptLoader} from "./helpers/typescript-loader.mjs";

const session="20000000-0000-4000-8000-000000000001";
const question="50000000-0000-4000-8000-000000000001";
const other="50000000-0000-4000-8000-000000000002";
const input={session_id:session,design_context:{primary_category_id:null,subcategory_id:null,
  other_category_text:null,stage_id:null,additional_context:null},context_ids:[],answered_questions:[
  {question_id:question,slot_index:1,question_text:"무엇인가요?",
    answer:{original:"원문",refined:null,current_version:"original",selected:"원문"}},
  {question_id:other,slot_index:2,question_text:"무엇을 고르나요?",
    answer:{original:"색",refined:null,current_version:"original",selected:"색",
      choice_selection:{selected_options:["색"],other:"",explanation:""}}},
]};

function fixture(fail=false) {
  const rows=new Map(),calls={refine:0,phases:[]};
  const trusted={
    from(){return {select(){return this;},in(){return this;},eq(){return this;},
      abortSignal:async()=>({data:[{id:question,answer_form:null},{id:other,answer_form:{kind:"choice"}}],error:null})};},
    rpc(name,p){return {abortSignal:async()=>{
      if(name==="completion_refinement_phase"){calls.phases.push(p.p_phase);return {data:null,error:null};}
      if(name==="claim_completion_refinement") {
        const row=rows.get(p.p_source_hash);
        if(row)return {data:row.state==="completed"?{state:"completed",result:row.result}:
          {state:row.state,result:null},error:null};
        rows.set(p.p_source_hash,{state:"running"});return {data:{state:"claimed",id:1},error:null};
      }
      if(name==="finish_completion_refinement") {
        const row=[...rows.values()][0];
        row.state=p.p_result===null?"failed":"completed";row.result=p.p_result;
        return {data:null,error:null};
      }
      throw new Error(name);
    }};},
  };
  const load=typescriptLoader({
    "@/lib/ai/server/sentence-refinement-config":{sentenceRefinementConfig:()=>({apiKey:"mock",model:"MOCK"})},
    "@/lib/ai/server/sentence-refinement":{refineSentence:async()=>{
      calls.refine++;if(fail)throw new Error("mock failure");return "다듬은 원문";
    }},
  });
  return {trusted,calls,run:load("src/lib/session-completion/refinement-service.ts").refineCompletionAnswers};
}

for(const fail of [false,true])test(`automatic refinement ${fail?"failure uses original":"success is reused"} without duplicate calls`,async()=>{
  const f=fixture(fail);
  const result=await f.run(f.trusted,"participant","request",input);
  assert.equal(result.answered_questions[0].answer.selected,fail?"원문":"다듬은 원문");
  assert.equal(result.answered_questions[1].answer.selected,"색");
  assert.equal(input.answered_questions[0].answer.original,"원문");
  const retry=await f.run(f.trusted,"participant","retry",input);
  assert.equal(retry.answered_questions[0].answer.selected,fail?"원문":"다듬은 원문");
  assert.equal(f.calls.refine,1);
  assert.deepEqual(f.calls.phases,["refining","briefing","refining","briefing"]);
});
