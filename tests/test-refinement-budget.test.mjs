import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync,mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";
import process from "node:process";

const require=createRequire(import.meta.url);
function load() {
  const module={exports:{}};
  const code=ts.transpileModule(readFileSync("scripts/test-runtime/refinement-budget.ts","utf8"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  runInThisContext(`(function(require,module,exports){${code}\n})`)(require,module,module.exports);
  return module.exports;
}

test("durable TEST budget blocks invalid requests, concurrent calls, reloads and provider retries",async()=>{
  const folder=mkdtempSync(join(tmpdir(),"whybox-refinement-budget-"));
  const env={...process.env},fetch=globalThis.fetch;
  const prompt="TEST prompt";
  process.env.NEXT_PUBLIC_SUPABASE_URL="https://njtgxnlxlhxpbiekbgmv.supabase.co";
  process.env.OPENAI_CONTEXT_DRAFT_ENABLED="false";
  process.env.OPENAI_QUESTION_GENERATION_MODEL="";
  process.env.WHY_BOX_TEST_PROMPT_HASH=createHash("sha256").update(prompt).digest("hex");
  process.env.WHY_BOX_TEST_REFINEMENT_BUDGET=join(folder,"budget");
  let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error("TEST timeout");};
  try {
    const guard=load();
    const body={model:"gpt-6-astra",store:false,stream:false,instructions:prompt,
      input:[{role:"user",content:[{type:"input_text",text:guard.E2E_ANSWER}]}]};
    const request={method:"POST",body:JSON.stringify(body)};
    await assert.rejects(guard.refinementBudgetFetch("https://api.openai.com/v1/models",request));
    await assert.rejects(guard.refinementBudgetFetch("https://api.openai.com/v1/responses",{
      ...request,body:JSON.stringify({...body,store:true}),
    }));
    assert.equal(calls,0);
    const results=await Promise.allSettled([
      guard.refinementBudgetFetch("https://api.openai.com/v1/responses",request),
      guard.refinementBudgetFetch("https://api.openai.com/v1/responses",request),
    ]);
    assert.equal(results.every(result=>result.status==="rejected"),true);
    assert.equal(calls,1);
    await assert.rejects(load().refinementBudgetFetch("https://api.openai.com/v1/responses",request));
    assert.equal(calls,1);
    const result=JSON.parse(readFileSync(join(folder,"budget.result.json")));
    assert.equal(result.calls,1);
    assert.equal(result.status,"failed");
  } finally {
    globalThis.fetch=fetch;
    for(const key of Object.keys(process.env))if(!Object.hasOwn(env,key))delete process.env[key];
    Object.assign(process.env,env);
    rmSync(folder,{recursive:true});
  }
});
