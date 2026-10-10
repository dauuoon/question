import {regenerationPendingSchema,regenerationMessages} from "./regeneration-contract";
import {questionActionMessages} from "./actions-contract";

export const REGENERATION_POLL_MS=1000;
export const REGENERATION_MAX_READS=90;
export async function readRegenerationResult(sessionId:string,requestId:string,signal:AbortSignal) {
  const response=await fetch(`/api/question-action?${new URLSearchParams({session_id:sessionId,request_id:requestId})}`,
    {cache:"no-store",signal});
  return {response,body:await response.json()};
}
export async function waitForRegeneration(sessionId:string,requestId:string,questionId:string,
  signal:AbortSignal,first?:Awaited<ReturnType<typeof readRegenerationResult>>) {
  for(let read=0;read<REGENERATION_MAX_READS;read++) {
    const result=read===0&&first?first:await readRegenerationResult(sessionId,requestId,signal);
    if(result.response.status!==202)return result;
    const pending=regenerationPendingSchema.safeParse(result.body);
    if(!pending.success||pending.data.request_id!==requestId||pending.data.question_id!==questionId) {
      throw new Error("Invalid regeneration recovery state");
    }
    await new Promise<void>((resolve,reject)=>{
      const cancel=()=>{clearTimeout(timer);reject(new Error("Regeneration read cancelled"));};
      const timer=setTimeout(()=>{signal.removeEventListener("abort",cancel);resolve();},REGENERATION_POLL_MS);
      signal.addEventListener("abort",cancel,{once:true});
      if(signal.aborted)cancel();
    });
  }
  throw new Error("Regeneration recovery deadline");
}
export function regenerationErrorMessage(code:string) {
  return regenerationMessages[code]??questionActionMessages[code]??questionActionMessages["QA-DB"];
}
