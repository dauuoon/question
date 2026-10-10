import "server-only";
import type {z} from "zod";
import {questionActionRequestSchema,QuestionActionError} from "../../question-generation/actions-contract";
import type {RegenerationBegin,RegenerationStatus,RegenerationCommit} from "../../question-generation/regeneration-contract";
import {questionRegenerationConfig,QUESTION_REGENERATION_TIMEOUT_MS} from "./question-regeneration-config";
import {generateRegenerationQuestion} from "./question-regeneration";
import {validateRegenerationOutput,type RegenerationAttempt} from "./question-regeneration-validation";

export type RegenerationInput=z.infer<typeof questionActionRequestSchema>;
export interface RegenerationRepository {
  begin(input:RegenerationInput):Promise<RegenerationBegin>;
  read(sessionId:string,requestId:string):Promise<RegenerationStatus>;
  attempt(attemptId:string,requestId:string):Promise<RegenerationAttempt>;
  images(attempt:RegenerationAttempt):Promise<string[]>;
  dispatch(attempt:RegenerationAttempt,model:string):Promise<boolean>;
  stage(attempt:RegenerationAttempt,validated:ReturnType<typeof validateRegenerationOutput>,
    metadata:Awaited<ReturnType<typeof generateRegenerationQuestion>>):Promise<void>;
  commit(attemptId:string,requestId:string):Promise<RegenerationCommit>;
  fail(attemptId:string,requestId:string,code:string,unknown:boolean):Promise<void>;
}
type Dependencies={
  config:typeof questionRegenerationConfig;
  generate:typeof generateRegenerationQuestion;
};
const dependencies:Dependencies={config:questionRegenerationConfig,generate:generateRegenerationQuestion};

export function withinRegenerationDeadline<T>(operation:PromiseLike<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    const cancel=()=>reject(new QuestionActionError("QR-TIMEOUT",504));
    signal.addEventListener("abort",cancel,{once:true});
    if(signal.aborted)cancel();
    Promise.resolve(operation).then(resolve,reject).finally(()=>signal.removeEventListener("abort",cancel));
  });
}
function resultFromStatus(status:RegenerationStatus):RegenerationCommit {
  if(status.status!=="committed"||!status.result_question_id)throw new QuestionActionError("QR-RECOVERY");
  return {request_id:status.request_id,question_id:status.question_id,
    result_question_id:status.result_question_id,changed:status.changed};
}
export async function recoverQuestionRegeneration(repo:RegenerationRepository,sessionId:string,requestId:string) {
  const status=await repo.read(sessionId,requestId);
  if(status.status==="committed")return resultFromStatus(status);
  if(status.status==="staged"&&status.attempt_id)return repo.commit(status.attempt_id,requestId);
  if(["failed","outcome_unknown","stale"].includes(status.status)) {
    throw new QuestionActionError(status.failure_code??(status.status==="stale"?"QA-STALE":"QR-OUTCOME-UNKNOWN"),409);
  }
  return status;
}
export async function runQuestionRegeneration(repo:RegenerationRepository,input:RegenerationInput,
  deps:Dependencies=dependencies):Promise<RegenerationCommit|RegenerationStatus> {
  const begin=await repo.begin(input);
  if(begin.status==="committed")return resultFromStatus(begin);
  if(!begin.acquired)return recoverQuestionRegeneration(repo,input.session_id,input.request_id);
  if(!begin.attempt_id)throw new QuestionActionError("QR-RECOVERY");
  let dispatched=false,providerSucceeded=false;
  try {
    const config=deps.config();
    const attempt=await repo.attempt(begin.attempt_id,input.request_id);
    if(attempt.id!==begin.attempt_id||attempt.request_id!==input.request_id||attempt.session_id!==input.session_id||
      attempt.question_id!==input.question_id||attempt.status!=="reserved")throw new QuestionActionError("QA-STALE",409);
    const urls=await repo.images(attempt);
    if(!await repo.dispatch(attempt,config.model))return recoverQuestionRegeneration(repo,input.session_id,input.request_id);
    dispatched=true;
    // Do not tie the durable dispatch to browser disconnect. A timeout still consumes its budget.
    const signal=AbortSignal.timeout(QUESTION_REGENERATION_TIMEOUT_MS);
    const output=await withinRegenerationDeadline(deps.generate(config,attempt,urls,signal),signal);
    providerSucceeded=true;
    const validated=validateRegenerationOutput(output.output,attempt);
    await repo.stage(attempt,validated,output);
    return await repo.commit(attempt.id,input.request_id);
  } catch(error) {
    const safe=error instanceof QuestionActionError?error:new QuestionActionError("QR-RECOVERY");
    // A durable staged result is recoverable after an uncertain DB/HTTP response; never re-POST to the provider.
    if(providerSucceeded&&safe.code==="QR-RECOVERY") {
      console.error("WHY BOX question regeneration: QR-RECOVERY");
      return recoverQuestionRegeneration(repo,input.session_id,input.request_id);
    }
    try {
      await repo.fail(begin.attempt_id,input.request_id,safe.code,dispatched&&["QR-TIMEOUT","QR-OUTCOME-UNKNOWN","QR-RECOVERY"].includes(safe.code));
    } catch {
      console.error("WHY BOX question regeneration: failure persistence QR-RECOVERY");
      throw new QuestionActionError("QR-RECOVERY");
    }
    throw safe;
  }
}
