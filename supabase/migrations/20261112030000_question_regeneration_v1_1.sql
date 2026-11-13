do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.question_regeneration_dispatch_metadata'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%question-regeneration-v1.0%'
  loop
    execute format(
      'alter table public.question_regeneration_dispatch_metadata drop constraint %I',
      v_constraint.conname
    );
  end loop;
end;
$$;

alter table public.question_regeneration_dispatch_metadata
  add constraint question_regeneration_dispatch_metadata_prompt_version_check
  check (prompt_version in ('question-regeneration-v1.0', 'question-regeneration-v1.1'));

create or replace function public.lock_question_regeneration(
  p_attempt_id uuid,p_request_id uuid,p_participant_id uuid,p_recheck boolean
)
returns uuid language plpgsql security definer set search_path='' as $$
declare a public.question_regeneration_attempts%rowtype; r public.question_regeneration_requests%rowtype;
  s public.sessions%rowtype; q public.questions%rowtype; ans public.answers%rowtype; snap jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Trusted server required' using errcode='42501'; end if;
  if p_attempt_id is null or p_request_id is null or p_participant_id is null or p_recheck is null then
    raise exception 'Request identity required' using errcode='22023';
  end if;
  select * into a from public.question_regeneration_attempts where id=p_attempt_id;
  if not found then raise exception 'Attempt not found' using errcode='42501'; end if;
  select * into s from public.sessions where id=a.session_id for update;
  select * into r from public.question_regeneration_requests where id=a.regeneration_request_id;
  if s.participant_id<>p_participant_id or r.participant_id<>p_participant_id or r.request_id<>p_request_id then
    raise exception 'Request identity changed' using errcode='42501';
  end if;
  perform 1 from public.profiles where id=p_participant_id and role='participant' and status='active' for share;
  if p_recheck and not found then raise exception 'Active Participant required' using errcode='42501'; end if;
  if p_recheck then
    if s.status<>'in_progress' or public.question_generation_has_running(s.id) then
      raise exception 'Session read-only' using errcode='55000';
    end if;
    perform 1 from public.questions where id=a.root_question_id and session_id=s.id for update;
    select * into q from public.questions where id=r.question_id and session_id=s.id for update;
    select * into ans from public.answers where question_id=q.id for update;
    if not q.is_active_version or q.root_question_id<>a.root_question_id or q.regeneration_index>=2
      or ans.updated_at is distinct from r.expected_answer_revision then
      raise exception 'Question or answer changed' using errcode='40001';
    end if;
    if q.status='answered' or length(btrim(coalesce(ans.original_answer,'')))>0
      or length(btrim(coalesce(ans.refined_answer,'')))>0 then
      raise exception 'Written answers must be preserved' using errcode='55000';
    end if;
    snap:=public.question_regeneration_snapshot(s.id);
    if (a.input_snapshot - 'supplemental_context')<>snap->'input'
      or a.image_snapshot<>snap->'images' or a.exclusion_snapshot<>snap->'exclusions' then
      raise exception 'Regeneration snapshot changed' using errcode='40001';
    end if;
  end if;
  perform 1 from public.question_regeneration_requests where id=r.id for update;
  perform 1 from public.question_regeneration_attempts where id=a.id for update;
  return r.id;
end;
$$;

create or replace function public.authorize_question_regeneration_dispatch(
  p_attempt_id uuid, p_request_id uuid, p_participant_id uuid,
  p_model_id text, p_prompt_version text, p_schema_version text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  acquired boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501',
      message = 'Trusted regeneration server required';
  end if;

  if p_model_id is null or length(btrim(p_model_id)) not between 1 and 200
    or p_prompt_version is null
    or p_prompt_version not in ('question-regeneration-v1.0', 'question-regeneration-v1.1')
    or p_schema_version is distinct from 'why_box_question_regeneration_v1_0' then
    raise exception using errcode = '22023',
      message = 'Invalid regeneration dispatch provenance';
  end if;

  acquired := public.authorize_question_regeneration_dispatch(
    p_attempt_id, p_request_id, p_participant_id
  );

  if acquired then
    insert into public.question_regeneration_dispatch_metadata
      (attempt_id, model_id, prompt_version, schema_version,
       validation_version, similarity_threshold)
    values (p_attempt_id, btrim(p_model_id), p_prompt_version, p_schema_version,
      'question-regeneration-validation-v1.0', 0.82);
  end if;
  return acquired;
end;
$$;

create or replace function public.begin_question_regeneration(
  p_session_id uuid, p_question_id uuid, p_request_id uuid,
  p_participant_id uuid, p_expected_answer_revision timestamptz, p_allow_api boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.sessions%rowtype;
  q public.questions%rowtype;
  ans public.answers%rowtype;
  r public.question_regeneration_requests%rowtype;
  action public.question_action_requests%rowtype;
  snap jsonb;
  result jsonb;
  rid uuid;
  v_supplemental_context text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Trusted server required' using errcode = '42501';
  end if;
  if p_request_id is null or p_allow_api is null then
    raise exception 'Invalid request' using errcode = '22023';
  end if;

  select * into s from public.sessions where id = p_session_id for update;
  if not found or s.participant_id <> p_participant_id then
    raise exception 'Participant ownership required' using errcode = '42501';
  end if;

  perform 1 from public.profiles
  where id = p_participant_id and role = 'participant' and status = 'active' for share;
  if not found then
    raise exception 'Active Participant required' using errcode = '42501';
  end if;

  select * into r from public.question_regeneration_requests
  where session_id = p_session_id and request_id = p_request_id;
  if found then
    if r.question_id <> p_question_id or r.participant_id <> p_participant_id
      or r.expected_answer_revision is distinct from p_expected_answer_revision
      or r.allow_api <> p_allow_api then
      raise exception 'Request identity changed' using errcode = '40001';
    end if;
    return public.question_regeneration_result(r.id);
  end if;

  select * into action from public.question_action_requests
  where session_id = p_session_id and request_id = p_request_id;
  if found then
    if action.question_id <> p_question_id or action.action <> 'regenerate'
      or action.participant_id <> p_participant_id
      or action.expected_answer_revision is distinct from p_expected_answer_revision then
      raise exception 'Request identity changed' using errcode = '40001';
    end if;
    return jsonb_build_object('request_id', p_request_id, 'question_id', p_question_id,
      'status', 'completed', 'acquired', false, 'attempt_id', null,
      'result_question_id', action.result_question_id, 'changed', false, 'method', 'reserve');
  end if;

  if exists(select 1 from public.question_regeneration_requests
    where session_id = p_session_id
      and status in ('reserved', 'dispatch_started', 'staged')) then
    raise exception 'Regeneration pending' using errcode = '55P03';
  end if;

  if s.status <> 'in_progress'
    or public.question_generation_has_running(s.id) then
    raise exception 'Session read-only' using errcode = '55000';
  end if;

  select * into q from public.questions
  where id = p_question_id and session_id = s.id for update;
  if not found or not q.is_active_version
    or q.question_kind not in ('original', 'regenerated') then
    raise exception 'Question version changed' using errcode = '40001';
  end if;

  perform 1 from public.questions
  where id = q.root_question_id and session_id = s.id for update;

  select * into ans from public.answers
  where question_id = q.id for update;

  if ans.updated_at is distinct from p_expected_answer_revision then
    raise exception 'Answer revision changed' using errcode = '40001';
  end if;

  if q.status = 'answered'
    or length(btrim(coalesce(ans.original_answer, ''))) > 0
    or length(btrim(coalesce(ans.refined_answer, ''))) > 0 then
    raise exception 'Written answers must be preserved' using errcode = '55000';
  end if;

  if q.regeneration_index >= 2 then
    raise exception 'Regeneration limit reached' using errcode = '54000';
  end if;

  if exists(
    select 1
    from public.question_candidates c
    join public.question_generation_attempts a on a.id = c.attempt_id
    join public.questions root on root.id = q.root_question_id
    join public.question_candidates initial on initial.id = root.source_candidate_id
    where c.attempt_id = initial.attempt_id
      and a.status = 'completed'
      and c.candidate_rank > a.requested_question_count
      and not exists(
        select 1 from public.questions used
        where used.source_candidate_id = c.id
      )
  ) then
    result := public.apply_question_action(
      s.id, q.id, p_request_id, 'regenerate',
      p_participant_id, p_expected_answer_revision
    );

    insert into public.question_regeneration_requests(
      session_id, participant_id, request_id, question_id,
      expected_answer_revision, allow_api, status, method,
      result_question_id, finished_at
    )
    values(
      s.id, p_participant_id, p_request_id, q.id,
      p_expected_answer_revision, p_allow_api, 'completed', 'reserve',
      (result->>'result_question_id')::uuid, clock_timestamp()
    )
    returning id into rid;

    insert into public.question_regeneration_events(
      regeneration_request_id, session_id, event_type
    ) values(rid, s.id, 'completed');

    return public.question_regeneration_result(rid, false, true);
  end if;

  if not p_allow_api then
    raise exception 'No unused reserve candidate' using errcode = 'P0002';
  end if;

  if (
    select count(*) from public.question_regeneration_attempts
    where session_id = s.id and dispatched_at is not null
  ) >= 3 then
    raise exception 'API dispatch limit reached' using errcode = '54000';
  end if;

  snap := public.question_regeneration_snapshot(s.id);

  select revision.context_text into v_supplemental_context
  from public.session_context_supplement_revisions revision
  where revision.session_id = s.id
  order by revision.revision desc
  limit 1;

  snap := jsonb_set(snap, '{input}',
    coalesce(snap->'input', '{}'::jsonb) ||
      jsonb_build_object('supplemental_context', v_supplemental_context),
    true);

  if jsonb_array_length(snap->'images') not between 1 and 10 then
    raise exception 'Images required' using errcode = '22023';
  end if;

  insert into public.question_regeneration_requests(
    session_id, participant_id, request_id, question_id,
    expected_answer_revision, allow_api, status, method
  )
  values(
    s.id, p_participant_id, p_request_id, q.id,
    p_expected_answer_revision, true, 'reserved', 'api_generated'
  )
  returning id into rid;

  insert into public.question_regeneration_attempts(
    regeneration_request_id, session_id, root_question_id,
    input_snapshot, image_snapshot, exclusion_snapshot
  )
  values(
    rid, s.id, q.root_question_id,
    snap->'input', snap->'images', snap->'exclusions'
  );

  insert into public.question_regeneration_events(
    regeneration_request_id, session_id, event_type
  ) values(rid, s.id, 'reserved');

  return public.question_regeneration_result(rid, true, false);
end;
$$;
