import { openSync,closeSync,writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const E2E_ANSWER="지금 화면에서 버튼이 너무 많아보이긴 하는데 사실 어떤걸 먼저 눌러야할지 잘 모르겠어요. 사용자가 처음 들어왔을때 뭘 해야하는지 조금 헷갈릴수도 있을거 같고, 근데 버튼을 줄이면 필요한 기능을 찾기 어려워질수도 있어서 아직 어떤 방식이 더 나은지는 잘 모르겠어요.";

export async function refinementBudgetFetch(
  input:RequestInfo|URL,init?:RequestInit,
):Promise<Response> {
  if(process.env.NEXT_PUBLIC_SUPABASE_URL!=="https://njtgxnlxlhxpbiekbgmv.supabase.co"||
    process.env.OPENAI_CONTEXT_DRAFT_ENABLED!=="false"||process.env.OPENAI_QUESTION_GENERATION_MODEL) {
    throw new Error("TEST refinement isolation failed");
  }
  const url=input instanceof Request?input.url:String(input);
  if(url!=="https://api.openai.com/v1/responses"||init?.method!=="POST"||typeof init.body!=="string") {
    throw new Error("TEST budget allows only Responses POST");
  }
  const body=JSON.parse(init.body);
  if(body.model!=="gpt-6-astra"||body.store!==false||body.stream!==false||
    body.input?.length!==1||body.input[0]?.role!=="user"||
    body.input[0]?.content?.length!==1||body.input[0]?.content[0]?.type!=="input_text"||
    body.input[0]?.content[0]?.text!==E2E_ANSWER||
    createHash("sha256").update(body.instructions??"").digest("hex")!==process.env.WHY_BOX_TEST_PROMPT_HASH) {
    throw new Error("TEST refinement request contract mismatch");
  }
  const budget=process.env.WHY_BOX_TEST_REFINEMENT_BUDGET;
  if(!budget)throw new Error("Missing durable TEST call budget");
  // O_EXCL consumes the budget before network I/O, across workers and restarts.
  closeSync(openSync(budget,"wx",0o600));
  const started=Date.now();
  writeFileSync(`${budget}.result.json`,JSON.stringify({calls:1,model:body.model,status:"started"}));
  try {
    const response=await globalThis.fetch(input,init);
    const output=await response.clone().json();
    writeFileSync(`${budget}.result.json`,JSON.stringify({
      calls:1,model:body.model,httpStatus:response.status,status:output.status,
      elapsedMs:Date.now()-started,usage:output.usage,output:output.output,
      store:false,maxRetries:0,
    },null,2));
    return response;
  } catch {
    writeFileSync(`${budget}.result.json`,JSON.stringify({
      calls:1,model:body.model,status:"failed",elapsedMs:Date.now()-started,
    }));
    throw new Error("TEST refinement provider failed; budget remains consumed");
  }
}
