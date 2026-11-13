import test from "node:test";
import assert from "node:assert/strict";
import { typescriptLoader } from "./helpers/typescript-loader.mjs";

const {refinementTargets}=typescriptLoader()("src/lib/session-completion/refinement-plan.ts");
const answer=(text)=>({original:text,refined:null,current_version:"original",selected:text});
const question=(id,value)=>({question_id:id,slot_index:1,question_text:"무엇인가요?",answer:value});
const input=(questions)=>({answered_questions:questions});
const kinds={first:"text",child:"text",empty:"text",option:"choice",refined:"text",direct:"choice",historic:"choice"};

test("completion refinement targets only original written answers and stable follow-up text",()=>{
  const parent=question("first",answer("작성한 답변"));
  parent.followup={question_id:"child",answer:answer("후속 답변")};
  const targets=refinementTargets(input([parent]),kinds);
  assert.deepEqual(targets.map(({questionId,sourceText,kind})=>({questionId,sourceText,kind})),[
    {questionId:"first",sourceText:"작성한 답변",kind:"text"},
    {questionId:"child",sourceText:"후속 답변",kind:"text"},
  ]);
  assert.match(targets[0].sourceHash,/^[a-f0-9]{64}$/);
  assert.equal(refinementTargets(input([parent]),kinds)[0].sourceHash,targets[0].sourceHash);
  assert.notEqual(refinementTargets(input([question("first",answer("바뀐 답변"))]),kinds)[0].sourceHash,targets[0].sourceHash);
});

test("completion skips blank, already selected refined, and option-only answers",()=>{
  const option={...answer("색"),choice_selection:{selected_options:["색"],other:"",explanation:""}};
  const selectedRefined={original:"원문",refined:"사용자가 확정한 표현",current_version:"refined",selected:"사용자가 확정한 표현"};
  assert.deepEqual(refinementTargets(input([
    question("empty",answer(" \n")),question("option",option),question("refined",selectedRefined),
  ]),kinds),[]);
});

test("completion refines direct choice writing but preserves historical mixed selections",()=>{
  const direct={...answer("직접 쓴 생각"),choice_selection:{selected_options:[],other:"직접 쓴 생각",explanation:""}};
  const historical={...answer("색\n\n이전 설명"),choice_selection:{selected_options:["색"],other:"",explanation:"이전 설명"}};
  const [target]=refinementTargets(input([question("direct",direct),question("historic",historical)]),kinds);
  assert.equal(target.kind,"choice_other");
  assert.equal(target.sourceText,"직접 쓴 생각");
  assert.equal(refinementTargets(input([question("historic",historical)]),kinds).length,0);
  assert.deepEqual(refinementTargets(input([question("option",answer("과거 보기"))]),kinds),[]);
  assert.deepEqual(refinementTargets(input([question("unknown",answer("과거 답변"))]),kinds),[]);
});
