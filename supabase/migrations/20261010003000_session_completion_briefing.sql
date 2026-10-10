begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

create table public.session_briefing_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete restrict,
  participant_id uuid not null references public.profiles(id) on delete restrict,
  request_id uuid not null,
  attempt_number smallint not null check (attempt_number between 1 and 2),
  retry_of_request_id uuid,
  state text not null check (state in (
    'ready', 'dispatch_started', 'completed', 'failed', 'dispatch_unknown'
  )),
  input_snapshot jsonb not null check (jsonb_typeof(input_snapshot) = 'object'),
  failure_code text,
  created_at timestamptz not null default clock_timestamp(),
  dispatch_started_at timestamptz,
  finished_at timestamptz,
  unique (session_id, request_id),
  unique (session_id, attempt_number),
  unique (id, session_id),
  foreign key (session_id, retry_of_request_id)
    references public.session_briefing_requests(session_id, request_id) on delete restrict,
  check (
    (attempt_number = 1 and retry_of_request_id is null)
    or (attempt_number = 2 and retry_of_request_id is not null)
  ),
  check (
    (state in ('completed', 'failed', 'dispatch_unknown')) = (finished_at is not null)
  ),
  check (
    state not in ('dispatch_started', 'completed', 'dispatch_unknown')
    or dispatch_started_at is not null
  ),
  check (
    (state in ('failed', 'dispatch_unknown')) = (failure_code is not null)
  )
);
create unique index session_briefing_one_pending_request
  on public.session_briefing_requests(session_id)
  where state in ('ready', 'dispatch_started');

create table public.session_briefing_sources (
  session_id uuid primary key references public.sessions(id) on delete restrict,
  participant_id uuid not null references public.profiles(id) on delete restrict,
  request_id uuid not null,
  source_text text not null check (length(btrim(source_text)) > 0),
  model_id text not null check (length(btrim(model_id)) between 1 and 200),
  prompt_version text not null check (length(btrim(prompt_version)) between 1 and 200),
  schema_version text not null check (length(btrim(schema_version)) between 1 and 200),
  generated_at timestamptz not null default clock_timestamp(),
  unique (session_id, request_id),
  foreign key (session_id, request_id)
    references public.session_briefing_requests(session_id, request_id) on delete restrict
);

create table public.session_briefing_versions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete restrict,
  revision integer not null check (revision > 0),
  briefing_text text not null check (length(btrim(briefing_text)) > 0),
  edited_by uuid not null references public.profiles(id) on delete restrict,
  edited_at timestamptz not null default clock_timestamp(),
  unique (session_id, revision)
);

create table public.session_diary_prompt_shown (
  session_id uuid primary key references public.sessions(id) on delete restrict,
  participant_id uuid not null references public.profiles(id) on delete restrict,
  shown_at timestamptz not null default clock_timestamp(),
  unique (participant_id, session_id)
);

alter table public.session_briefing_requests enable row level security;
alter table public.session_briefing_sources enable row level security;
alter table public.session_briefing_versions enable row level security;
alter table public.session_diary_prompt_shown enable row level security;

revoke all on public.session_briefing_requests, public.session_briefing_sources,
  public.session_briefing_versions, public.session_diary_prompt_shown
  from public, anon, authenticated, service_role;
grant select on public.session_briefing_requests, public.session_briefing_sources,
  public.session_briefing_versions, public.session_diary_prompt_shown to authenticated;

create policy session_briefing_requests_select_owner_or_admin
  on public.session_briefing_requests for select to authenticated
  using (public.owns_session(session_id) or public.is_active_admin());
create policy session_briefing_sources_select_owner_or_admin
  on public.session_briefing_sources for select to authenticated
  using (public.owns_session(session_id) or public.is_active_admin());
create policy session_briefing_versions_select_owner_or_admin
  on public.session_briefing_versions for select to authenticated
  using (public.owns_session(session_id) or public.is_active_admin());
create policy session_diary_prompt_select_owner_or_admin
  on public.session_diary_prompt_shown for select to authenticated
  using (public.owns_session(session_id) or public.is_active_admin());

create function public.guard_session_briefing_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Briefing history cannot be deleted' using errcode = '42501';
  end if;
  if tg_table_name = 'session_briefing_requests' then
    if (to_jsonb(new) - array['state', 'failure_code', 'dispatch_started_at', 'finished_at'])
      is distinct from
      (to_jsonb(old) - array['state', 'failure_code', 'dispatch_started_at', 'finished_at'])
      or not (
        (old.state = 'ready' and new.state in ('dispatch_started', 'failed'))
        or (old.state = 'dispatch_started' and new.state in ('completed', 'failed', 'dispatch_unknown'))
      )
      or (old.dispatch_started_at is not null and new.dispatch_started_at is distinct from old.dispatch_started_at) then
      raise exception 'Invalid briefing request transition' using errcode = '42501';
    end if;
  else
    raise exception 'Briefing history is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
alter function public.guard_session_briefing_history() owner to postgres;
revoke all on function public.guard_session_briefing_history() from public, anon, authenticated, service_role;
create trigger session_briefing_request_history_guard
  before update or delete on public.session_briefing_requests
  for each row execute function public.guard_session_briefing_history();
create trigger session_briefing_source_history_guard
  before update or delete on public.session_briefing_sources
  for each row execute function public.guard_session_briefing_history();
create trigger session_briefing_version_history_guard
  before update or delete on public.session_briefing_versions
  for each row execute function public.guard_session_briefing_history();
create trigger session_diary_prompt_history_guard
  before update or delete on public.session_diary_prompt_shown
  for each row execute function public.guard_session_briefing_history();

create function public.session_briefing_input_snapshot(p_session_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'session_id', s.id,
    'design_context', jsonb_build_object(
      'primary_category_id', s.primary_category_id,
      'subcategory_id', s.subcategory_id,
      'other_category_text', s.other_category_text,
      'stage_id', s.stage_id,
      'additional_context', s.additional_context
    ),
    'context_ids', coalesce((
      select jsonb_agg(sc.context_id order by sc.context_id)
      from public.session_contexts sc where sc.session_id = s.id
    ), '[]'::jsonb),
    'answered_questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'question_id', q.id,
        'slot_index', q.slot_index,
        'question_text', q.question_text,
        'answer', jsonb_build_object(
          'original', a.original_answer,
          'refined', a.refined_answer,
          'current_version', a.current_answer_version,
          'selected', case when a.current_answer_version = 'refined'
            then a.refined_answer else a.original_answer end
        )
      ) order by q.slot_index, q.id)
      from public.questions q
      join public.answers a on a.question_id = q.id
      where q.session_id = s.id and q.is_active_version
        and q.question_kind in ('original', 'regenerated')
        and q.status = 'answered'
        and length(btrim(case when a.current_answer_version = 'refined'
          then coalesce(a.refined_answer, '') else a.original_answer end)) > 0
    ), '[]'::jsonb)
  )
  from public.sessions s where s.id = p_session_id;
$$;
alter function public.session_briefing_input_snapshot(uuid) owner to postgres;
revoke all on function public.session_briefing_input_snapshot(uuid) from public, anon, authenticated, service_role;

create function public.begin_session_completion(
  p_session_id uuid, p_request_id uuid, p_retry_of_request_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.sessions%rowtype;
  existing public.session_briefing_requests%rowtype;
  prior public.session_briefing_requests%rowtype;
  snapshot jsonb;
  active_count integer;
  completed_count integer;
  answer_count integer;
  missing_ids uuid[];
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    raise exception 'Authenticated participant required' using errcode = '42501';
  end if;
  if p_session_id is null or p_request_id is null then
    raise exception 'Session and request identifiers are required' using errcode = '22023';
  end if;
  select * into s from public.sessions where id = p_session_id for update;
  if not found or s.participant_id <> auth.uid()
    or not exists (select 1 from public.profiles p where p.id = auth.uid()
      and p.role = 'participant' and p.status = 'active') then
    raise exception 'Session ownership required' using errcode = '42501';
  end if;
  select * into existing from public.session_briefing_requests
    where session_id = p_session_id and request_id = p_request_id;
  if found then
    return jsonb_build_object(
      'accepted', existing.state <> 'failed' and existing.state <> 'dispatch_unknown',
      'request_id', existing.request_id, 'state', existing.state,
      'attempt_number', existing.attempt_number,
      'retry_of_request_id', existing.retry_of_request_id,
      'missing_question_ids', '[]'::jsonb, 'has_answer', true,
      'input_snapshot', existing.input_snapshot, 'replayed', true
    );
  end if;

  if p_retry_of_request_id is not null then
    select * into prior from public.session_briefing_requests
      where session_id = p_session_id and request_id = p_retry_of_request_id
      for update;
    if not found or prior.attempt_number <> 1 or prior.state <> 'failed'
      or exists (select 1 from public.session_briefing_requests
        where session_id = p_session_id and attempt_number = 2) then
      raise exception 'Only one explicit retry after a definitive failure is allowed' using errcode = '55000';
    end if;
    if s.status <> 'summary_ready' then
      raise exception 'Session is not awaiting a briefing retry' using errcode = '55000';
    end if;
    insert into public.session_briefing_requests(
      session_id, participant_id, request_id, attempt_number, retry_of_request_id, state, input_snapshot
    ) values (
      p_session_id, auth.uid(), p_request_id, 2, p_retry_of_request_id, 'ready', prior.input_snapshot
    ) returning * into existing;
    return jsonb_build_object(
      'accepted', true, 'request_id', existing.request_id, 'state', existing.state,
      'attempt_number', existing.attempt_number, 'retry_of_request_id', existing.retry_of_request_id,
      'missing_question_ids', '[]'::jsonb, 'has_answer', true,
      'input_snapshot', existing.input_snapshot, 'replayed', false
    );
  end if;

  if s.status <> 'in_progress' then
    return jsonb_build_object(
      'accepted', false, 'request_id', p_request_id, 'state', 'blocked',
      'attempt_number', 0, 'retry_of_request_id', null,
      'missing_question_ids', '[]'::jsonb, 'has_answer', false,
      'input_snapshot', null, 'replayed', false
    );
  end if;
  select count(*) into active_count from public.questions q
    where q.session_id = p_session_id and q.is_active_version
      and q.question_kind in ('original', 'regenerated');
  select array_agg(q.id order by q.slot_index, q.id) into missing_ids
    from public.questions q left join public.answers a on a.question_id = q.id
    where q.session_id = p_session_id and q.is_active_version
      and q.question_kind in ('original', 'regenerated')
      and (
        q.status not in ('answered', 'skipped')
        or (q.status = 'answered' and length(btrim(case
          when a.current_answer_version = 'refined' then coalesce(a.refined_answer, '')
          else coalesce(a.original_answer, '') end)) = 0)
      );
  select count(*) into completed_count from public.questions q
    where q.session_id = p_session_id and q.is_active_version
      and q.question_kind in ('original', 'regenerated') and q.status in ('answered', 'skipped');
  select count(*) into answer_count
    from public.questions q join public.answers a on a.question_id = q.id
    where q.session_id = p_session_id and q.is_active_version
      and q.question_kind in ('original', 'regenerated') and q.status = 'answered'
      and length(btrim(case when a.current_answer_version = 'refined'
        then coalesce(a.refined_answer, '') else a.original_answer end)) > 0;
  if active_count = 0 or completed_count <> active_count or coalesce(array_length(missing_ids, 1), 0) > 0
    or answer_count = 0 then
    return jsonb_build_object(
      'accepted', false, 'request_id', p_request_id, 'state', 'blocked',
      'attempt_number', 0, 'retry_of_request_id', null,
      'missing_question_ids', coalesce(to_jsonb(missing_ids), '[]'::jsonb),
      'has_answer', answer_count > 0, 'input_snapshot', null, 'replayed', false
    );
  end if;
  if exists (select 1 from public.session_briefing_requests where session_id = p_session_id) then
    raise exception 'Completion has already been requested' using errcode = '55000';
  end if;
  snapshot := public.session_briefing_input_snapshot(p_session_id);
  insert into public.session_briefing_requests(
    session_id, participant_id, request_id, attempt_number, state, input_snapshot
  ) values (p_session_id, auth.uid(), p_request_id, 1, 'ready', snapshot)
  returning * into existing;
  update public.sessions set status = 'summary_ready' where id = p_session_id;
  return jsonb_build_object(
    'accepted', true, 'request_id', existing.request_id, 'state', existing.state,
    'attempt_number', existing.attempt_number, 'retry_of_request_id', null,
    'missing_question_ids', '[]'::jsonb, 'has_answer', true,
    'input_snapshot', snapshot, 'replayed', false
  );
end;
$$;
alter function public.begin_session_completion(uuid, uuid, uuid) owner to postgres;
revoke all on function public.begin_session_completion(uuid, uuid, uuid) from public, anon;
grant execute on function public.begin_session_completion(uuid, uuid, uuid) to authenticated;

create function public.read_session_briefing_request(p_session_id uuid, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.session_briefing_requests%rowtype;
begin
  if not (public.owns_session(p_session_id) or public.is_active_admin()) then
    raise exception 'Session access required' using errcode = '42501';
  end if;
  select * into r from public.session_briefing_requests
    where session_id = p_session_id and request_id = p_request_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'accepted', r.state not in ('failed', 'dispatch_unknown'),
    'request_id', r.request_id, 'state', r.state, 'attempt_number', r.attempt_number,
    'retry_of_request_id', r.retry_of_request_id,
    'missing_question_ids', '[]'::jsonb, 'has_answer', true,
    'input_snapshot', r.input_snapshot, 'replayed', true
  );
end;
$$;
alter function public.read_session_briefing_request(uuid, uuid) owner to postgres;
revoke all on function public.read_session_briefing_request(uuid, uuid) from public, anon;
grant execute on function public.read_session_briefing_request(uuid, uuid) to authenticated, service_role;

create function public.authorize_session_briefing_dispatch(
  p_session_id uuid, p_request_id uuid, p_participant_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare r public.session_briefing_requests%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted briefing server required' using errcode = '42501';
  end if;
  select * into r from public.session_briefing_requests
    where session_id = p_session_id and request_id = p_request_id and participant_id = p_participant_id
    for update;
  if not found or r.state <> 'ready' then return false; end if;
  update public.session_briefing_requests
    set state = 'dispatch_started', dispatch_started_at = clock_timestamp()
    where id = r.id;
  return true;
end;
$$;
alter function public.authorize_session_briefing_dispatch(uuid, uuid, uuid) owner to postgres;
revoke all on function public.authorize_session_briefing_dispatch(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.authorize_session_briefing_dispatch(uuid, uuid, uuid) to service_role;

create function public.finish_session_briefing(
  p_session_id uuid, p_request_id uuid, p_participant_id uuid,
  p_source_text text, p_model_id text, p_prompt_version text, p_schema_version text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.session_briefing_requests%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted briefing server required' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_source_text, ''))) not between 1 and 16000
    or length(btrim(coalesce(p_model_id, ''))) not between 1 and 200
    or length(btrim(coalesce(p_prompt_version, ''))) not between 1 and 200
    or length(btrim(coalesce(p_schema_version, ''))) not between 1 and 200 then
    raise exception 'Invalid briefing result or provenance' using errcode = '22023';
  end if;
  perform 1 from public.sessions where id = p_session_id for update;
  select * into r from public.session_briefing_requests
    where session_id = p_session_id and request_id = p_request_id and participant_id = p_participant_id
    for update;
  if not found then raise exception 'Briefing request not found' using errcode = 'P0002'; end if;
  if r.state = 'completed' then
    return jsonb_build_object('request_id', r.request_id, 'state', r.state, 'replayed', true);
  end if;
  if r.state <> 'dispatch_started' then
    raise exception 'Briefing request is not dispatched' using errcode = '55000';
  end if;
  insert into public.session_briefing_sources(
    session_id, participant_id, request_id, source_text, model_id, prompt_version, schema_version
  ) values (
    p_session_id, p_participant_id, p_request_id, btrim(p_source_text), btrim(p_model_id),
    btrim(p_prompt_version), btrim(p_schema_version)
  );
  update public.session_briefing_requests
    set state = 'completed', finished_at = clock_timestamp()
    where id = r.id;
  update public.sessions
    set status = 'completed', summary_text = btrim(p_source_text)
    where id = p_session_id and status = 'summary_ready';
  if not found then raise exception 'Session is not ready to complete' using errcode = '55000'; end if;
  return jsonb_build_object('request_id', p_request_id, 'state', 'completed', 'replayed', false);
end;
$$;
alter function public.finish_session_briefing(uuid, uuid, uuid, text, text, text, text) owner to postgres;
revoke all on function public.finish_session_briefing(uuid, uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.finish_session_briefing(uuid, uuid, uuid, text, text, text, text)
  to service_role;

create function public.fail_session_briefing(
  p_session_id uuid, p_request_id uuid, p_participant_id uuid,
  p_failure_code text, p_outcome_unknown boolean default false
) returns boolean language plpgsql security definer set search_path = '' as $$
declare r public.session_briefing_requests%rowtype;
declare next_state text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted briefing server required' using errcode = '42501';
  end if;
  if p_failure_code is null or length(btrim(p_failure_code)) not between 1 and 100 then
    raise exception 'Invalid briefing failure code' using errcode = '22023';
  end if;
  select * into r from public.session_briefing_requests
    where session_id = p_session_id and request_id = p_request_id and participant_id = p_participant_id
    for update;
  if not found or r.state not in ('ready', 'dispatch_started') then return false; end if;
  if p_outcome_unknown and r.state <> 'dispatch_started' then
    raise exception 'Unknown outcome requires an authorized dispatch' using errcode = '55000';
  end if;
  next_state := case when p_outcome_unknown then 'dispatch_unknown' else 'failed' end;
  update public.session_briefing_requests
    set state = next_state, failure_code = btrim(p_failure_code), finished_at = clock_timestamp()
    where id = r.id;
  return true;
end;
$$;
alter function public.fail_session_briefing(uuid, uuid, uuid, text, boolean) owner to postgres;
revoke all on function public.fail_session_briefing(uuid, uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.fail_session_briefing(uuid, uuid, uuid, text, boolean) to service_role;

create function public.save_session_briefing_version(
  p_session_id uuid, p_expected_revision integer, p_briefing_text text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.sessions%rowtype;
declare current_revision integer;
declare next_revision integer;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    raise exception 'Authenticated participant required' using errcode = '42501';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'A nonnegative briefing revision is required' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_briefing_text, ''))) not between 1 and 16000 then
    raise exception 'Invalid briefing text' using errcode = '22023';
  end if;
  select * into s from public.sessions where id = p_session_id for update;
  if not found or s.participant_id <> auth.uid() or s.status <> 'completed'
    or not exists (select 1 from public.profiles p where p.id = auth.uid()
      and p.role = 'participant' and p.status = 'active')
    or not exists (select 1 from public.session_briefing_sources b where b.session_id = p_session_id) then
    raise exception 'Completed briefing ownership required' using errcode = '42501';
  end if;
  select coalesce(max(v.revision), 0) into current_revision
    from public.session_briefing_versions v where v.session_id = p_session_id;
  if current_revision <> p_expected_revision then
    return jsonb_build_object('saved', false, 'current_revision', current_revision);
  end if;
  next_revision := current_revision + 1;
  insert into public.session_briefing_versions(session_id, revision, briefing_text, edited_by)
    values (p_session_id, next_revision, btrim(p_briefing_text), auth.uid());
  return jsonb_build_object('saved', true, 'revision', next_revision);
end;
$$;
alter function public.save_session_briefing_version(uuid, integer, text) owner to postgres;
revoke all on function public.save_session_briefing_version(uuid, integer, text) from public, anon;
grant execute on function public.save_session_briefing_version(uuid, integer, text) to authenticated;

create function public.claim_session_diary_prompt(p_session_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare s public.sessions%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    raise exception 'Authenticated participant required' using errcode = '42501';
  end if;
  select * into s from public.sessions where id = p_session_id for update;
  if not found or s.participant_id <> auth.uid() or s.status <> 'completed'
    or not exists (select 1 from public.profiles p where p.id = auth.uid()
      and p.role = 'participant' and p.status = 'active') then
    raise exception 'Completed session ownership required' using errcode = '42501';
  end if;
  if exists (select 1 from public.diaries d where d.session_id = p_session_id and d.status = 'submitted') then
    return false;
  end if;
  insert into public.session_diary_prompt_shown(session_id, participant_id)
    values (p_session_id, auth.uid()) on conflict (session_id) do nothing;
  return found;
end;
$$;
alter function public.claim_session_diary_prompt(uuid) owner to postgres;
revoke all on function public.claim_session_diary_prompt(uuid) from public, anon;
grant execute on function public.claim_session_diary_prompt(uuid) to authenticated;

commit;
