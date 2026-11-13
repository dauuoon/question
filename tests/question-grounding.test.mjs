import test from "node:test";
import assert from "node:assert/strict";
import { typescriptLoader } from "./helpers/typescript-loader.mjs";
import { pgliteFixture } from "./question-regeneration-fixture.mjs";

const load=typescriptLoader();
const current=load("src/lib/ai/prompts/question-generation-v2.14.ts").QUESTION_GENERATION_PROMPT;
const previous=load("prompt-history/2026-11-13-grounding-baseline/prompts/question-generation-v2.8.ts").QUESTION_GENERATION_PROMPT;
const section=(text,start,end)=>text.slice(text.indexOf(start),end?text.indexOf(end):undefined);

test("grounding revision preserves framework, answer forms and image contracts exactly",()=>{
  for(const [start,end] of [
    ["# QUESTION CONTENT FRAMEWORK","# GENERATION PRINCIPLES"],
    ["# IMAGE TARGET SELECTION","# FRAMEWORK METADATA"],
  ])assert.equal(section(current,start,end),section(previous,start,end));
  const rules=load("src/lib/ai/question-expression-rules.ts").QUESTION_EXPRESSION_RULES;
  const oldRules=load("prompt-history/2026-11-13-grounding-baseline/question-expression-rules.ts").QUESTION_EXPRESSION_RULES;
  const beforeChoice=load("prompt-history/2026-11-13-choice-form-baseline/question-expression-rules.ts").QUESTION_EXPRESSION_RULES;
  assert.equal(section(beforeChoice,"## 수량과 생각 단서"),section(oldRules,"## 수량과 생각 단서"));
  assert.match(rules,/여러 비교 항목이나 대안을 정리하는 것이 질문 목적에 적합할 때만/);
  assert.match(rules,/관찰한 요소·문구와 사용자가 입력한 목적·의도를 구분/);
  assert.match(rules,/확인형 표현으로도 미리 제시하지 않는다/);
  assert.match(rules,/사용자 테스트나 사용자에게 맡길 과제로 한정하지 않는다/);
  assert.match(rules,/가능한 방법이지 필수 절차/);
  assert.match(current,/GOOD:\n"이 키워드로 어떤 특징을 전달하려 했나요\?"/);
  assert.match(current,/GOOD:\n"인쇄물이나 디지털 화면에서도 색상과 겹침 효과가 원하는 대로 표현되는지, 어떤 방법으로 확인하면 좋을까요\?"/);
});

test("every active question prompt includes shared grounding rules without changing answer schemas",()=>{
  const rules=load("src/lib/ai/question-expression-rules.ts").QUESTION_EXPRESSION_RULES;
  for(const [path,prefix,title] of [
    ["question-generation-v2.14","QUESTION_GENERATION","QUESTION GENERATION"],
    ["question-regeneration-v1.9","QUESTION_REGENERATION","QUESTION REGENERATION"],
    ["question-followup-v1.9","QUESTION_FOLLOWUP","QUESTION FOLLOWUP"],
  ]) {
    const prompt=load(`src/lib/ai/prompts/${path}.ts`);
    assert.equal(prompt[`${prefix}_PROMPT_VERSION`],path);
    assert.equal(prompt[`${prefix}_PROMPT`].split(rules).length,2);
    assert.match(prompt[`${prefix}_PROMPT`],new RegExp(`# WHY BOX ${title} PROMPT ${path.split("-").at(-1).replace(".","\\.")}`));
  }
});

test("new initial version is stored with unchanged forms while historical versions remain valid",async t=>{
  const form={kind:"numbered",title:"확인할 기준",labels:["항목 1","항목 2"]};
  for(const version of ["question-generation-v2.8","question-generation-v2.9","question-generation-v2.10","question-generation-v2.11","question-generation-v2.12","question-generation-v2.13"]) {
    const f=await pgliteFixture(3,[form],version);t.after(()=>f.close());
    const attempts=(await f.db.query("select prompt_version,schema_version from question_generation_attempts")).rows;
    assert.ok(attempts.every(a=>a.prompt_version===version&&a.schema_version===(version==="question-generation-v2.13"?
      "why_box_question_generation_v2_2":"why_box_question_generation_v2_1")));
    assert.deepEqual(f.questions[0].answer_form,form);
    const candidates=(await f.db.query("select prompt_version,answer_form from question_candidates order by candidate_rank")).rows;
    assert.ok(candidates.every(c=>c.prompt_version===version));
    assert.deepEqual(candidates[0].answer_form,form);
  }
});

test("purpose revision replaces repetitive criteria and vague verification guidance without changing generation mechanics",()=>{
  const baseline=load("prompt-history/2026-11-13-question-purpose-baseline/prompts/question-generation-v2.9.ts").QUESTION_GENERATION_PROMPT;
  const rules=load("src/lib/ai/question-expression-rules.ts").QUESTION_EXPRESSION_RULES;
  const oldRules=load("prompt-history/2026-11-13-question-purpose-baseline/question-expression-rules.ts").QUESTION_EXPRESSION_RULES;
  const beforeChoice=load("prompt-history/2026-11-13-choice-form-baseline/question-expression-rules.ts").QUESTION_EXPRESSION_RULES;
  assert.equal(section(beforeChoice,"## 수량과 생각 단서"),section(oldRules,"## 수량과 생각 단서"));
  for(const clause of [
    /모든 질문을 판단 기준이나 근거를 설명하는 형태로 바꾸지 않는다/,
    /기준 탐색을 단순 선택으로, 가정 검토를 디자인 평가로 바꾸지 않는다/,
    /제공된 작업 설명과 답변에서 이미 밝힌 목적·이유·고려 사항/,
    /디자이너라는 이유만으로 기본 사항을 모두 고려했다고 추정하지 않는다/,
    /사용 매체가 입력되어 있으면 그 매체를 직접 언급/,
    /확인되지 않으면 인쇄나 디지털 중 하나로 단정/,
    /필요한 유지 조건과 바꿀 요소를 구분/,
    /대안 생성은 가능한 선택을, 결과 예상은 달라질 인상이나 경험/,
  ])assert.match(rules,clause);
  assert.match(current,/GOOD:\n"가운데 작은 글자 중, 반드시 읽혀야 하는 내용은 무엇인가요\?"/);
  assert.match(current,/GOOD:\n"색 조합은 그대로 두고 글꼴이나 배치를 바꾼다면, 어떤 다른 인상을 줄 수 있을까요\?"/);
  assert.doesNotMatch(current,/사용자가 자신의 기준과 근거를 설명하도록 한다/);
  assert.doesNotMatch(current,/판단 기준이나 구체적인 비교 대상으로 사고를 발전/);
  const ranking=text=>section(text,"# QUESTION GENERATION AND RANKING","# FINAL SELF-CHECK");
  // Only selection criteria and diversity changed; count, ranks and Reserve mechanics are exact.
  const mechanics=text=>ranking(text).replace(/4\. 순위를 결정할 때[\s\S]*?(?=6\. 5개의 질문)/,"");
  assert.equal(mechanics(current),mechanics(baseline));
  assert.match(ranking(current),/기준·근거 설명만 요구하는 질문이 상위 순위에 몰리지/);
  assert.match(ranking(current),/이미 답한 내용을 반복하지 않고 아직 알 수 없는 내용을 탐색/);
  const followup=load("src/lib/ai/prompts/question-followup-v1.9.ts").QUESTION_FOLLOWUP_PROMPT;
  assert.match(followup,/작업 설명과 저장된 답변/);
  const replacement=load("src/lib/ai/prompts/question-regeneration-v1.9.ts").QUESTION_REGENERATION_PROMPT;
  assert.match(replacement,/제공되지 않은 답변을 읽은 것처럼 추정하지 말고/);
});

test("text roles guide question choice without forcing readability or decoration",()=>{
  const rules=load("src/lib/ai/question-expression-rules.ts").QUESTION_EXPRESSION_RULES;
  for(const clause of [
    /모두 읽혀야 할 정보로 취급하거나 가독성 검토를 우선하지 않는다/,
    /정보 전달 목적을 설명했다면 맥락에 맞는 가독성 질문/,
    /장식 목적도 단정하지 말고/,
    /흐리거나 겹쳐 보인다는 관찰만으로 문제나 수정 필요성을 전제/,
    /질문 유형과 맥락에 따라 다음 중 적절한 관점을 선택/,
    /한꺼번에 생성하거나 순서를 강제하지 않는다/,
    /얇은 글꼴/,
  ]) assert.match(rules,clause);
  assert.match(rules,/잔 위의 흰 글자는 전체 이미지에서 어떤 역할을 하나요/);
  assert.match(rules,/흰 글자가 있을 때와 없을 때/);
  assert.match(rules,/흰 글자 대신 다른 시각적 요소/);
  assert.match(current,/역할이 불분명하면 가독성 검토를 자동으로 우선하지 않고/);
  assert.match(current,/정보 전달 목적을 설명했고 핵심 정보 선택이 필요한 경우/);
});

test("natural expression rules retain meaningful conditions, wording and blank alternative forms",()=>{
  const rules=load("src/lib/ai/question-expression-rules.ts").QUESTION_EXPRESSION_RULES;
  for(const clause of [
    /재방문이나 사용 경험처럼 판단에 영향을 주는 조건은 유지/,
    /문구 자체의 의미를 검토할 때는 확인된 원문을 그대로 유지/,
    /행동 예상과 설계 선택을 혼동하지 않는다/,
    /대안 탐색에 사용자 요구나 질문 목적에 필요하지 않은 고정 조건을 넣지 않는다/,
    /익숙하고 정확한 디자인 용어가 더 명확하면 사용/,
    /answer_form이 있으면 answer_guides는 빈 배열/,
  ]) assert.match(rules,clause);
  assert.match(current,/중립적인 제목과 빈 항목 두 개로 된 numbered answer_form/);
  assert.match(current,/현재 복용중인약 관리하기/);
  assert.match(current,/앱의 3D 그래픽으로 어떤 인상을/);
});
