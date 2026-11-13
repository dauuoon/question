begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

create function public.valid_question_answer_form(value jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
begin
  if value is null or value='null'::jsonb then return true; end if;
  if jsonb_typeof(value)<>'object'
    or not value ?& array['kind','title','labels']
    or (value-array['kind','title','labels'])<>'{}'::jsonb
    or coalesce(value->>'kind','') not in ('numbered','sections')
    or jsonb_typeof(value->'title') is distinct from 'string'
    or length(btrim(value->>'title')) not between 1 and 100
    or jsonb_typeof(value->'labels') is distinct from 'array' then return false; end if;
  if jsonb_array_length(value->'labels') not between 2 and 6
    or exists(select 1 from jsonb_array_elements(value->'labels') l
      where jsonb_typeof(l)<>'string' or length(btrim(l #>> '{}')) not between 1 and 100)
    or (select count(distinct btrim(l #>> '{}')) from jsonb_array_elements(value->'labels') l)
      <>jsonb_array_length(value->'labels') then return false; end if;
  return true;
end;
$$;

alter table public.question_candidates add column answer_form jsonb
  check(public.valid_question_answer_form(answer_form));
alter table public.questions add column answer_form jsonb
  check(public.valid_question_answer_form(answer_form));
alter table public.answers add column original_answer_fields text[]
  check(original_answer_fields is null or cardinality(original_answer_fields) between 2 and 6);
alter table public.question_followup_requests add column schema_version text;
grant insert(original_answer_fields), update(original_answer_fields) on public.answers to authenticated;

alter function public.validate_question_candidates(jsonb,jsonb,jsonb,integer)
  rename to validate_question_candidates_without_forms;
create function public.validate_question_candidates(
  p_candidates jsonb,p_input jsonb,p_images jsonb,p_count integer
) returns void language plpgsql immutable set search_path='' as $$
declare candidate jsonb; stripped jsonb;
begin
  if p_candidates is null or jsonb_typeof(p_candidates)<>'array'
    or octet_length(p_candidates::text)>262144 then
    raise exception 'Invalid candidate payload' using errcode='22023';
  end if;
  for candidate in select value from jsonb_array_elements(p_candidates) loop
    if not public.valid_question_answer_form(candidate->'answer_form')
      or (candidate->'answer_form' is not null and candidate->'answer_form'<>'null'::jsonb
        and candidate->'answer_guides'<>'[]'::jsonb) then
      raise exception 'Invalid answer form or duplicate guides' using errcode='22023';
    end if;
  end loop;
  select jsonb_agg(value-'answer_form' order by ordinal) into stripped
    from jsonb_array_elements(p_candidates) with ordinality item(value,ordinal);
  perform public.validate_question_candidates_without_forms(stripped,p_input,p_images,p_count);
end;
$$;

alter function public.validate_question_regeneration_candidate(jsonb,jsonb,jsonb,jsonb)
  rename to validate_question_regeneration_candidate_without_forms;
create function public.validate_question_regeneration_candidate(
  p_candidate jsonb,p_input jsonb,p_images jsonb,p_exclusions jsonb
) returns void language plpgsql immutable set search_path='' as $$
begin
  if octet_length(p_candidate::text)>32768
    or not public.valid_question_answer_form(p_candidate->'answer_form')
    or (p_candidate->'answer_form' is not null and p_candidate->'answer_form'<>'null'::jsonb
      and p_candidate->'answer_guides'<>'[]'::jsonb) then
    raise exception 'Invalid answer form or duplicate guides' using errcode='22023';
  end if;
  perform public.validate_question_regeneration_candidate_without_forms(
    p_candidate-'answer_form',p_input,p_images,p_exclusions
  );
end;
$$;

create function public.capture_question_answer_form()
returns trigger language plpgsql security definer set search_path='' as $$
declare form jsonb; payload jsonb;
begin
  if tg_op='UPDATE' then
    if new.answer_form is distinct from old.answer_form then
      raise exception 'Question answer form is immutable' using errcode='42501';
    end if;
    return new;
  end if;
  if tg_table_name='question_candidates' then
    select candidate into payload from public.question_generation_attempts a,
      lateral jsonb_array_elements(a.validated_candidates) candidate
      where a.id=new.attempt_id and (candidate->>'candidate_rank')::integer=new.candidate_rank;
    form:=payload->'answer_form';
  elsif new.source_candidate_id is not null then
    select c.answer_form into form from public.question_candidates c where c.id=new.source_candidate_id;
  elsif new.source_regeneration_candidate_id is not null then
    select c.candidate->'answer_form' into form from public.question_regeneration_candidates c
      where c.id=new.source_regeneration_candidate_id;
  else
    form:=new.answer_form;
  end if;
  new.answer_form:=nullif(form,'null'::jsonb);
  return new;
end;
$$;
create trigger question_candidates_answer_form before insert or update on public.question_candidates
  for each row execute function public.capture_question_answer_form();
create trigger questions_answer_form before insert or update on public.questions
  for each row execute function public.capture_question_answer_form();

create function public.capture_followup_schema_version()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    new.schema_version:=case when new.prompt_version='question-followup-v1.3'
      then 'why_box_question_followup_v1_1' else 'why_box_question_followup_v1_0' end;
  elsif new.schema_version is distinct from old.schema_version then
    raise exception 'Follow-up schema version is immutable' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger question_followup_schema_version before insert or update on public.question_followup_requests
  for each row execute function public.capture_followup_schema_version();

create function public.guard_regeneration_answer_form()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.prompt_version='question-regeneration-v1.3' and (
    new.schema_version<>'why_box_question_regeneration_v1_1' or not new.candidate ? 'answer_form') then
    raise exception 'New regeneration requires form-aware schema' using errcode='22023';
  end if;
  return new;
end;
$$;
create trigger regeneration_candidates_answer_form before insert on public.question_regeneration_candidates
  for each row execute function public.guard_regeneration_answer_form();

create function public.guard_answer_fields()
returns trigger language plpgsql security definer set search_path='' as $$
declare form jsonb; rendered text; session_status text;
begin
  if tg_op='UPDATE' and new.original_answer_fields is distinct from old.original_answer_fields then
    select s.status into session_status from public.sessions s join public.questions q on q.session_id=s.id
      where q.id=new.question_id;
    if session_status<>'in_progress' or exists(
      select 1 from public.questions q where q.parent_question_id=new.question_id and q.question_kind='followup'
    ) then raise exception 'Answer fields are read-only' using errcode='42501'; end if;
  end if;
  if new.original_answer_fields is null then return new; end if;
  select q.answer_form into form from public.questions q where q.id=new.question_id;
  if form is null or array_ndims(new.original_answer_fields)<>1 or array_lower(new.original_answer_fields,1)<>1
    or cardinality(new.original_answer_fields)<>jsonb_array_length(form->'labels')
    or exists(select 1 from unnest(new.original_answer_fields) v where v is null or length(v)>20000) then
    raise exception 'Answer fields do not match question form' using errcode='22023';
  end if;
  select coalesce(string_agg(v,E'\n\n' order by position),'') into rendered
    from unnest(new.original_answer_fields) with ordinality item(v,position)
    where v !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]*$';
  if rendered<>new.original_answer or length(rendered)>20000 then
    raise exception 'Answer text must contain only user field values' using errcode='22023';
  end if;
  return new;
end;
$$;
create trigger answers_fields_guard before insert or update on public.answers
  for each row execute function public.guard_answer_fields();

create function public.question_answer_forms_ready()
returns boolean language sql stable set search_path='' as $$ select true $$;
revoke all on function public.question_answer_forms_ready() from public,anon;
grant execute on function public.question_answer_forms_ready() to authenticated,service_role;

alter table public.question_generation_attempts drop constraint question_generation_attempts_prompt_metadata_check;
alter table public.question_generation_attempts add constraint question_generation_attempts_prompt_metadata_check check(
  (validated_candidates is null and model_id is null and prompt_version is null and schema_version is null
    and framework_version is null and generated_at is null)
  or (validated_candidates is not null and model_id is not null and length(btrim(model_id))>0
    and ((prompt_version in ('question-generation-v2.5','question-generation-v2.6','question-generation-v2.7')
      and schema_version='why_box_question_generation_v2_0')
      or (prompt_version='question-generation-v2.8' and schema_version='why_box_question_generation_v2_1'))
    and prompt_version is not null and schema_version is not null
    and framework_version='v1.0' and framework_version is not null and generated_at is not null)
);
alter table public.question_candidates drop constraint question_candidates_prompt_version_check;
alter table public.question_candidates add constraint question_candidates_prompt_version_check
  check(prompt_version in ('question-generation-v2.5','question-generation-v2.6','question-generation-v2.7','question-generation-v2.8'));
alter table public.question_candidates drop constraint question_candidates_schema_version_check;
alter table public.question_candidates add constraint question_candidates_schema_version_check
  check((prompt_version='question-generation-v2.8' and schema_version='why_box_question_generation_v2_1')
    or (prompt_version<>'question-generation-v2.8' and schema_version='why_box_question_generation_v2_0'));
alter table public.question_regeneration_dispatch_metadata
  drop constraint question_regeneration_dispatch_metadata_prompt_version_check;
alter table public.question_regeneration_dispatch_metadata
  drop constraint question_regeneration_dispatch_metadata_schema_version_check;
alter table public.question_regeneration_dispatch_metadata
  add constraint question_regeneration_dispatch_metadata_prompt_version_check
  check((prompt_version in ('question-regeneration-v1.0','question-regeneration-v1.1','question-regeneration-v1.2')
    and schema_version='why_box_question_regeneration_v1_0')
    or (prompt_version='question-regeneration-v1.3' and schema_version='why_box_question_regeneration_v1_1'));

create or replace function public.stage_question_generation_candidates(
  p_attempt_id uuid,p_request_id uuid,p_candidates jsonb,p_model_id text,
  p_prompt_version text,p_schema_version text,p_framework_version text,p_generated_at timestamptz
) returns boolean language plpgsql security definer set search_path='' as $$
declare a public.question_generation_attempts%rowtype; s public.sessions%rowtype; snap jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Trusted server required' using errcode='42501';
  end if;
  select sessions.* into s from public.sessions sessions join public.question_generation_attempts attempts
    on attempts.session_id=sessions.id where attempts.id=p_attempt_id and attempts.request_id=p_request_id
    for update of sessions;
  if not found then raise exception 'Attempt not found' using errcode='22023'; end if;
  select * into a from public.question_generation_attempts where id=p_attempt_id for update;
  if a.status='completed' then return false; end if;
  if a.status<>'running' or s.status not in ('draft','question_generation') then
    raise exception 'Attempt is not running' using errcode='55000';
  end if;
  perform 1 from public.profiles where id=s.participant_id and status='active' and role='participant' for share;
  if not found then raise exception 'Active Participant required' using errcode='42501'; end if;
  snap:=public.question_generation_snapshot(s.id);
  if a.input_snapshot<>snap->'input' or a.image_snapshot<>snap->'images'
    or a.requested_question_count<>(snap->>'requested_question_count')::integer then
    raise exception 'Generation snapshot changed' using errcode='40001';
  end if;
  perform public.validate_question_candidates(p_candidates,a.input_snapshot,a.image_snapshot,a.requested_question_count);
  if p_model_id is null or length(btrim(p_model_id))=0 or p_generated_at is null
    or p_framework_version is distinct from 'v1.0'
    or not coalesce(
      (p_prompt_version in ('question-generation-v2.5','question-generation-v2.6','question-generation-v2.7')
        and p_schema_version='why_box_question_generation_v2_0')
      or (p_prompt_version='question-generation-v2.8' and p_schema_version='why_box_question_generation_v2_1'),false)
    or (p_prompt_version='question-generation-v2.8' and exists(
      select 1 from jsonb_array_elements(p_candidates) c where not c ? 'answer_form')) then
    raise exception 'Invalid generation metadata' using errcode='22023';
  end if;
  if a.validated_candidates is not null then
    if a.validated_candidates<>p_candidates or a.model_id<>p_model_id or a.prompt_version<>p_prompt_version
      or a.schema_version<>p_schema_version or a.framework_version<>p_framework_version
      or a.generated_at<>p_generated_at then
      raise exception 'Staged candidates are immutable' using errcode='22023';
    end if;
    return false;
  end if;
  update public.question_generation_attempts set validated_candidates=p_candidates,model_id=p_model_id,
    prompt_version=p_prompt_version,schema_version=p_schema_version,framework_version=p_framework_version,
    generated_at=p_generated_at where id=p_attempt_id;
  return true;
end;
$$;

create or replace function public.authorize_question_regeneration_dispatch(
  p_attempt_id uuid,p_request_id uuid,p_participant_id uuid,p_model_id text,p_prompt_version text,p_schema_version text
) returns boolean language plpgsql security definer set search_path='' as $$
declare acquired boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted regeneration server required' using errcode='42501';
  end if;
  if p_model_id is null or length(btrim(p_model_id)) not between 1 and 200 or not coalesce(
    (p_prompt_version in ('question-regeneration-v1.0','question-regeneration-v1.1','question-regeneration-v1.2')
      and p_schema_version='why_box_question_regeneration_v1_0')
    or (p_prompt_version='question-regeneration-v1.3' and p_schema_version='why_box_question_regeneration_v1_1'),false) then
    raise exception 'Invalid regeneration dispatch provenance' using errcode='22023';
  end if;
  acquired:=public.authorize_question_regeneration_dispatch(p_attempt_id,p_request_id,p_participant_id);
  if acquired then
    insert into public.question_regeneration_dispatch_metadata(
      attempt_id,model_id,prompt_version,schema_version,validation_version,similarity_threshold
    ) values(p_attempt_id,btrim(p_model_id),p_prompt_version,p_schema_version,'question-regeneration-validation-v1.0',0.82);
  end if;
  return acquired;
end;
$$;

create function public.finish_question_followup(
  p_request_id uuid,p_outcome text,p_question_text text,p_model_id text,
  p_input_tokens integer,p_output_tokens integer,p_failure_code text,p_answer_form jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.question_followup_requests%rowtype; q public.questions%rowtype;
  a public.answers%rowtype; s public.sessions%rowtype; child_id uuid; answer_text text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Trusted server required' using errcode='42501'; end if;
  if not public.valid_question_answer_form(p_answer_form)
    or (p_outcome<>'generated' and p_answer_form is not null and p_answer_form<>'null'::jsonb) then
    raise exception 'Invalid follow-up form' using errcode='22023';
  end if;
  select * into r from public.question_followup_requests where id=p_request_id for update;
  if not found then raise exception 'Follow-up request not found' using errcode='P0002'; end if;
  if r.status in ('generated','no_followup','failed','outcome_unknown') then
    return jsonb_build_object('id',r.id,'request_id',r.request_id,'status',r.status,
      'result_question_id',r.result_question_id,'answer_snapshot',r.answer_snapshot);
  end if;
  if r.status<>'dispatch_started' or p_outcome not in ('generated','no_followup') then
    raise exception 'Follow-up dispatch and generated outcome required' using errcode='55000';
  end if;
  if r.prompt_version<>'question-followup-v1.3' then
    raise exception 'Form-aware follow-up prompt required' using errcode='22023';
  end if;
  select * into s from public.sessions where id=r.session_id for update;
  select * into q from public.questions where id=r.parent_question_id and session_id=r.session_id for update;
  select * into a from public.answers where question_id=r.parent_question_id for update;
  answer_text:=case when a.current_answer_version='refined' then coalesce(a.refined_answer,'') else coalesce(a.original_answer,'') end;
  if s.status<>'in_progress' or not q.is_active_version or q.status<>'answered'
    or a.updated_at is distinct from r.expected_answer_updated_at or answer_text is distinct from r.answer_snapshot
    or exists(select 1 from public.questions existing where existing.root_question_id=r.root_question_id
      and existing.question_kind='followup') then
    p_outcome:='outcome_unknown'; p_failure_code:='FOLLOWUP-STALE';
  end if;
  if p_outcome='generated' then
    if p_question_text is null or length(btrim(p_question_text))=0 or length(p_question_text)>2000 then
      raise exception 'Invalid follow-up question' using errcode='22023';
    end if;
    child_id:=gen_random_uuid();
    insert into public.questions(id,session_id,root_question_id,parent_question_id,question_kind,slot_index,
      regeneration_index,followup_index,question_text,target_type,selection_reason,model_id,prompt_version,
      framework_version,generated_at,is_active_version,answer_form)
    values(child_id,r.session_id,r.root_question_id,r.parent_question_id,'followup',q.slot_index,null,1,
      btrim(p_question_text),q.target_type,'response_based_followup',p_model_id,r.prompt_version,
      'v1.0',clock_timestamp(),false,nullif(p_answer_form,'null'::jsonb));
    insert into public.question_targets(question_id,session_id,image_id,x,y,width,height,sort_order)
      select child_id,r.session_id,image_id,x,y,width,height,sort_order from public.question_targets where question_id=q.id;
  end if;
  update public.question_followup_requests set status=p_outcome,result_question_id=child_id,
    model_id=coalesce(p_model_id,model_id),input_tokens=p_input_tokens,output_tokens=p_output_tokens,
    failure_code=p_failure_code,finished_at=clock_timestamp(),schema_version='why_box_question_followup_v1_1'
    where id=r.id returning * into r;
  insert into public.question_events(session_id,question_id,participant_id,event_type,event_data)
    values(r.session_id,r.parent_question_id,r.participant_id,'followup_requested',
      jsonb_build_object('request_id',r.request_id,'outcome',r.status,'followup_question_id',r.result_question_id,
        'prompt_version',r.prompt_version,'schema_version',r.schema_version,'answer_form',p_answer_form,
        'model_id',r.model_id,'input_tokens',r.input_tokens,'output_tokens',r.output_tokens,'failure_code',r.failure_code));
  return jsonb_build_object('id',r.id,'request_id',r.request_id,'status',r.status,
    'result_question_id',r.result_question_id,'answer_snapshot',r.answer_snapshot);
end;
$$;

alter function public.valid_question_answer_form(jsonb) owner to postgres;
alter function public.validate_question_candidates(jsonb,jsonb,jsonb,integer) owner to postgres;
alter function public.validate_question_regeneration_candidate(jsonb,jsonb,jsonb,jsonb) owner to postgres;
alter function public.capture_question_answer_form() owner to postgres;
alter function public.guard_answer_fields() owner to postgres;
alter function public.capture_followup_schema_version() owner to postgres;
alter function public.guard_regeneration_answer_form() owner to postgres;
alter function public.finish_question_followup(uuid,text,text,text,integer,integer,text,jsonb) owner to postgres;
revoke all on function public.validate_question_candidates(jsonb,jsonb,jsonb,integer),
  public.validate_question_regeneration_candidate(jsonb,jsonb,jsonb,jsonb),
  public.capture_question_answer_form(),public.guard_answer_fields(),
  public.capture_followup_schema_version(),public.guard_regeneration_answer_form(),
  public.finish_question_followup(uuid,text,text,text,integer,integer,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.validate_question_candidates(jsonb,jsonb,jsonb,integer),
  public.validate_question_regeneration_candidate(jsonb,jsonb,jsonb,jsonb),
  public.finish_question_followup(uuid,text,text,text,integer,integer,text,jsonb) to service_role;

commit;
