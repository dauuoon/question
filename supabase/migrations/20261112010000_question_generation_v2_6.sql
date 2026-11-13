do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.question_generation_attempts'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%question-generation-v2.5%'
  loop
    execute format(
      'alter table public.question_generation_attempts drop constraint %I',
      v_constraint.conname
    );
  end loop;

  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.question_candidates'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%question-generation-v2.5%'
  loop
    execute format(
      'alter table public.question_candidates drop constraint %I',
      v_constraint.conname
    );
  end loop;
end;
$$;

alter table public.question_generation_attempts
  add constraint question_generation_attempts_prompt_metadata_check
  check (
    (validated_candidates is null and model_id is null and prompt_version is null
      and schema_version is null and framework_version is null and generated_at is null)
    or (validated_candidates is not null
      and length(btrim(model_id)) > 0 and model_id is not null
      and prompt_version in ('question-generation-v2.5', 'question-generation-v2.6')
      and schema_version = 'why_box_question_generation_v2_0'
      and schema_version is not null
      and framework_version = 'v1.0'
      and framework_version is not null
      and generated_at is not null)
  );

alter table public.question_candidates
  add constraint question_candidates_prompt_version_check
  check (prompt_version in ('question-generation-v2.5', 'question-generation-v2.6'));

create or replace function public.stage_question_generation_candidates(
  p_attempt_id uuid, p_request_id uuid, p_candidates jsonb, p_model_id text,
  p_prompt_version text, p_schema_version text, p_framework_version text, p_generated_at timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_attempt public.question_generation_attempts%rowtype;
  v_session public.sessions%rowtype;
  v_snapshot jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Trusted server required' using errcode = '42501';
  end if;

  select s.* into v_session
  from public.sessions s
  join public.question_generation_attempts a on a.session_id=s.id
  where a.id=p_attempt_id and a.request_id=p_request_id
  for update of s;

  if not found then
    raise exception 'Attempt not found' using errcode = '22023';
  end if;

  select * into v_attempt
  from public.question_generation_attempts a
  where a.id=p_attempt_id
  for update;

  if v_attempt.status = 'completed' then return false; end if;

  if v_attempt.status <> 'running'
     or v_session.status not in ('draft','question_generation') then
    raise exception 'Attempt is not running' using errcode = '55000';
  end if;

  perform 1 from public.profiles p
  where p.id=v_session.participant_id
    and p.status='active'
    and p.role='participant'
  for share;

  if not found then
    raise exception 'Active Participant required' using errcode = '42501';
  end if;

  v_snapshot := public.question_generation_snapshot(v_session.id);

  if v_attempt.input_snapshot <> v_snapshot->'input'
     or v_attempt.image_snapshot <> v_snapshot->'images'
     or v_attempt.requested_question_count <>
        (v_snapshot->>'requested_question_count')::integer then
    raise exception 'Generation snapshot changed' using errcode = '40001';
  end if;

  perform public.validate_question_candidates(
    p_candidates,
    v_attempt.input_snapshot,
    v_attempt.image_snapshot,
    v_attempt.requested_question_count
  );

  if p_model_id is null
     or length(btrim(p_model_id))=0
     or p_prompt_version is null
     or p_prompt_version not in ('question-generation-v2.5', 'question-generation-v2.6')
     or p_schema_version is distinct from 'why_box_question_generation_v2_0'
     or p_framework_version is distinct from 'v1.0'
     or p_generated_at is null then
    raise exception 'Invalid generation metadata' using errcode = '22023';
  end if;

  if v_attempt.validated_candidates is not null then
    if v_attempt.validated_candidates <> p_candidates
       or v_attempt.model_id <> p_model_id
       or v_attempt.prompt_version <> p_prompt_version
       or v_attempt.schema_version <> p_schema_version
       or v_attempt.framework_version <> p_framework_version
       or v_attempt.generated_at <> p_generated_at then
      raise exception 'Staged candidates are immutable' using errcode = '22023';
    end if;
    return false;
  end if;

  update public.question_generation_attempts
  set validated_candidates=p_candidates,
      model_id=p_model_id,
      prompt_version=p_prompt_version,
      schema_version=p_schema_version,
      framework_version=p_framework_version,
      generated_at=p_generated_at
  where id=p_attempt_id;

  return true;
end;
$$;
