import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import {QuestionActionError,questionActionCommitSchema} from "./actions-contract";
import {regenerationBeginSchema,regenerationStatusSchema} from "./regeneration-contract";
import {regenerationAttemptSchema} from "../ai/server/question-regeneration-validation";
import type {RegenerationRepository} from "../ai/server/question-regeneration-service";
import {withinRegenerationDeadline} from "../ai/server/question-regeneration-service";
import {QUESTION_REGENERATION_PROMPT_VERSION} from "../ai/prompts/question-regeneration-v1.0";
import {QUESTION_REGENERATION_SCHEMA} from "../ai/schemas/question-regeneration-v1.0";
import {IMAGE_BUCKET} from "../images/limits";

export function regenerationDatabaseError(code:string,message?:string):QuestionActionError {
  const errors:Record<string,[string,number]>={
    "42501":["QA-AUTH",403],"22023":["QA-INPUT",400],"55000":["QA-STATE",409],
    "40001":["QA-STALE",409],"54000":["QR-CALL-LIMIT",409],
    "55P03":["QR-BUSY",409],"P0002":["QA-RESERVE",409],
    "23505":["QR-BUSY",409],
    "PGRST202":["QA-UNAVAILABLE",409],"42883":["QA-UNAVAILABLE",409],
  };
  const [safe,status]=code==="54000"&&message==="Regeneration limit reached"
    ?["QA-LIMIT",409]:errors[code]??["QR-RECOVERY",503];
  return new QuestionActionError(safe,status);
}
export function createRegenerationRepository(caller:SupabaseClient,trusted:SupabaseClient,userId:string):RegenerationRepository {
  async function rpc(name:string,parameters:Record<string,unknown>) {
    const result=await trusted.rpc(name,parameters).abortSignal(AbortSignal.timeout(10_000));
    if(result.error)throw regenerationDatabaseError(result.error.code,result.error.message);
    return result.data as unknown;
  }
  async function checked<T>(schema:z.ZodType<T>,name:string,parameters:Record<string,unknown>) {
    const parsed=schema.safeParse(await rpc(name,parameters));
    if(!parsed.success)throw new QuestionActionError("QR-RECOVERY");
    return parsed.data;
  }
  const databaseStatusSchema=z.object({
    request_id:z.uuid(),question_id:z.uuid(),
    status:z.enum(["reserved","dispatch_started","staged","completed","failed","dispatch_unknown"]),
    acquired:z.boolean(),attempt_id:z.uuid().nullable(),result_question_id:z.uuid().nullable(),
    changed:z.boolean(),method:z.enum(["reserve","api_generated"]),error_code:z.string().nullable().default(null),
  }).strict();
  const errors:Record<string,string>={
    "QR-STALE":"QA-STALE","QR-LIMIT":"QA-LIMIT","QR-BUDGET":"QR-CALL-LIMIT",
    "QR-EXPIRED":"QR-OUTCOME-UNKNOWN","QR-DISPATCH-UNKNOWN":"QR-OUTCOME-UNKNOWN",
  };
  function normalizedStatus(raw:z.infer<typeof databaseStatusSchema>) {
    return {...raw,status:raw.status==="completed"?"committed":
      raw.status==="dispatch_unknown"?"outcome_unknown":raw.status,
      failure_code:raw.error_code===null?null:errors[raw.error_code]??raw.error_code};
  }
  async function state(name:string,parameters:Record<string,unknown>) {
    const raw=await checked(databaseStatusSchema,name,parameters);
    const {error_code,...value}=normalizedStatus(raw);
    void error_code;
    return value;
  }
  return {
    async begin(input) {
      return regenerationBeginSchema.parse(await state("begin_question_regeneration",{
        p_session_id:input.session_id,p_question_id:input.question_id,p_request_id:input.request_id,
        p_participant_id:userId,p_expected_answer_revision:input.expected_answer_revision,p_allow_api:true,
      }));
    },
    async read(sessionId,requestId) {
      const result=await caller.rpc("read_question_regeneration",{
        p_session_id:sessionId,p_request_id:requestId,
      }).abortSignal(AbortSignal.timeout(10_000));
      if(result.error)throw regenerationDatabaseError(result.error.code);
      const parsed=databaseStatusSchema.safeParse(result.data);
      if(!parsed.success||parsed.data.request_id!==requestId)throw new QuestionActionError("QR-RECOVERY");
      let value=normalizedStatus(parsed.data);
      if(value.attempt_id&&["reserved","dispatch_started","staged"].includes(value.status)) {
        const recovered=await state("recover_question_regeneration",{
          p_attempt_id:value.attempt_id,p_request_id:requestId,p_participant_id:userId,
        });
        value={...recovered,error_code:null};
      }
      const {acquired,error_code,...status}=value;
      void acquired;void error_code;
      return regenerationStatusSchema.parse(status);
    },
    async attempt(attemptId,requestId) {
      const raw=await rpc("get_question_regeneration_attempt",{
        p_attempt_id:attemptId,p_request_id:requestId,p_participant_id:userId,
      });
      const record=z.record(z.string(),z.unknown()).safeParse(raw);
      if(!record.success)throw new QuestionActionError("QR-RECOVERY");
      const fields=Object.keys(regenerationAttemptSchema.shape);
      const selected=Object.fromEntries(fields.map(key=>[key,record.data[key]]));
      const exclusions=z.array(z.object({id:z.uuid(),question_text:z.string().min(1)})).safeParse(selected.exclusion_snapshot);
      if(!exclusions.success)throw new QuestionActionError("QR-RECOVERY");
      selected.exclusion_snapshot=exclusions.data;
      if(selected.status==="completed")selected.status="committed";
      if(selected.status==="dispatch_unknown")selected.status="outcome_unknown";
      const parsed=regenerationAttemptSchema.safeParse(selected);
      if(!parsed.success)throw new QuestionActionError("QR-RECOVERY");
      return parsed.data;
    },
    async images(attempt) {
      const urls:string[]=[];
      const signal=AbortSignal.timeout(10_000);
      for(const image of attempt.image_snapshot) {
        if(!image.storage_path.startsWith(`${userId}/${attempt.session_id}/`))throw new QuestionActionError("QR-IMAGE");
        const bucket=caller.storage.from(IMAGE_BUCKET);
        const slash=image.storage_path.lastIndexOf("/");
        const name=image.storage_path.slice(slash+1);
        const listed=await withinRegenerationDeadline(bucket.list(image.storage_path.slice(0,slash),{search:name,limit:100}),signal);
        if(listed.error||!listed.data?.some(object=>object.name===name&&object.id))throw new QuestionActionError("QR-IMAGE");
        const signed=await withinRegenerationDeadline(bucket.createSignedUrl(image.storage_path,300),signal);
        if(signed.error||!signed.data?.signedUrl)throw new QuestionActionError("QR-IMAGE");
        urls.push(signed.data.signedUrl);
      }
      return urls;
    },
    dispatch:async(attempt,model)=>checked(z.boolean(),"authorize_question_regeneration_dispatch",{
      p_attempt_id:attempt.id,p_request_id:attempt.request_id,p_participant_id:userId,
      p_model_id:model,p_prompt_version:QUESTION_REGENERATION_PROMPT_VERSION,p_schema_version:QUESTION_REGENERATION_SCHEMA.name,
    }),
    async stage(attempt,validated,metadata) {
      const staged=await checked(z.object({candidate_id:z.uuid(),attempt_id:z.uuid(),staged:z.boolean()}).strict(),"stage_question_regeneration_candidate",{
        p_attempt_id:attempt.id,p_request_id:attempt.request_id,p_participant_id:userId,
        p_candidate:validated.candidate,
        p_model_id:metadata.model,p_generated_at:metadata.generatedAt,
        p_prompt_version:QUESTION_REGENERATION_PROMPT_VERSION,p_schema_version:QUESTION_REGENERATION_SCHEMA.name,
        p_framework_version:"v1.0",
      });
      if(staged.attempt_id!==attempt.id)throw new QuestionActionError("QA-STALE",409);
    },
    async commit(attemptId,requestId) {
      const raw=await state("commit_question_regeneration",{
        p_attempt_id:attemptId,p_request_id:requestId,p_participant_id:userId,
      });
      if(raw.status!=="committed"||!raw.result_question_id)throw new QuestionActionError(raw.failure_code??"QA-STALE",409);
      return questionActionCommitSchema.parse({request_id:raw.request_id,question_id:raw.question_id,
        result_question_id:raw.result_question_id,changed:raw.changed});
    },
    async fail(attemptId,requestId,code,unknown) {
      const failed=await checked(z.boolean(),"fail_question_regeneration",{
        p_attempt_id:attemptId,p_request_id:requestId,p_participant_id:userId,
        p_error_code:code==="QA-STALE"?"QR-STALE":code,p_outcome_unknown:unknown,
      });
      if(!failed)throw new QuestionActionError("QR-RECOVERY");
    },
  };
}
