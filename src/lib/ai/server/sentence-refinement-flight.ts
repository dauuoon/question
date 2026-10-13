import "server-only";
import { SentenceRefinementError } from "../sentence-refinement-contract";

const flights=new Map<string,{revision:string;promise:Promise<{refined_text:string;updated_at:string}>}>();
const MAX_FLIGHTS=100;

// Process-local coalescing complements, but does not replace, the DB revision check.
export function runSentenceRefinement(
  userId:string,questionId:string,revision:string,
  operation:()=>Promise<{refined_text:string;updated_at:string}>,
) {
  const key=`${userId}:${questionId}`;
  const existing=flights.get(key);
  if(existing) {
    if(existing.revision!==revision)throw new SentenceRefinementError("REFINE-BUSY",409);
    return existing.promise;
  }
  if(flights.size>=MAX_FLIGHTS)throw new SentenceRefinementError("REFINE-CAPACITY",429);
  const promise=Promise.resolve().then(operation).finally(()=>{
    if(flights.get(key)?.promise===promise)flights.delete(key);
  });
  flights.set(key,{revision,promise});
  return promise;
}
