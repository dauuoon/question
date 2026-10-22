begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

create table public.question_followup_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete restrict,
  participant_id uuid not null references public.profiles(id) on delete restrict,
  request_id uuid not null,
  root_question_id uuid not null,
  parent_question_id uuid not null,
  expected_answer_updated_at timestamptz not null,
  answer_hash text not null check (answer_hash ~ '^[0-9a-f]{64}$'),
  answer_snapshot text not null,
  status text not null check (status in (
    'reserved', 'dispatch_started', 'generated', 'no_followup', 'failed', 'outcome_unknown'
  )),
  result_question_id uuid,
  prompt_version text not null,
  model_id text,
  failure_code text,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  created_at timestamptz not null default clock_timestamp(),
  dispatched_at timestamptz,
  finished_at timestamptz,
  unique (session_id, request_id),
  foreign key (root_question_id, session_id) references public.questions(id, session_id) on delete restrict,
  foreign key (parent_question_id, session_id) references public.questions(id, session_id) on delete restrict,
  foreign key (result_question_id, session_id) references public.questions(id, session_id) on delete restrict,
  check ((status = 'generated') = (result_question_id is not null)),
  check ((status in ('generated', 'no_followup', 'failed', 'outcome_unknown')) = (finished_at is not null)),
  check (
    (status = 'reserved' and dispatched_at is null)
    or status = 'failed'
    or (status in ('dispatch_started', 'generated', 'no_followup', 'outcome_unknown')
      and dispatched_at is not null)
  )
);

create unique index question_followup_one_pending_per_root
  on public.question_followup_requests(root_question_id)
  where status in ('reserved', 'dispatch_started');
create unique index question_followup_one_success_per_root
  on public.question_followup_requests(root_question_id)
  where status = 'generated';
create unique index question_followup_answer_outcome_unique
  on public.question_followup_requests(root_question_id, answer_hash)
  where status in ('dispatch_started', 'generated', 'no_followup', 'outcome_unknown');

alter table public.question_followup_requests enable row level security;
revoke all on public.question_followup_requests from public, anon, authenticated, service_role;
grant select on public.question_followup_requests to authenticated, service_role;
create policy question_followup_requests_select_owner_or_admin
  on public.question_followup_requests for select to authenticated
  using (public.owns_session(session_id) or public.is_active_admin());

create function public.guard_question_followup_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Follow-up research history cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status','result_question_id','model_id','failure_code',
      'input_tokens','output_tokens','dispatched_at','finished_at'])
    is distinct from
    (to_jsonb(old) - array['status','result_question_id','model_id','failure_code',
      'input_tokens','output_tokens','dispatched_at','finished_at'])
    or not (
      (old.status = 'reserved' and new.status in ('dispatch_started','failed','outcome_unknown'))
      or (old.status = 'dispatch_started' and new.status in ('generated','no_followup','failed','outcome_unknown'))
    ) then
    raise exception 'Invalid follow-up request transition' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger question_followup_requests_history
  before update or delete on public.question_followup_requests
  for each row execute function public.guard_question_followup_history();

create function public.guard_question_followup_answer_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare q public.questions%rowtype;
begin
  if tg_op = 'UPDATE' then
    select * into q from public.questions where id = new.question_id;
    if exists (
      select 1 from public.questions child
        where child.parent_question_id = q.id and child.question_kind = 'followup'
    ) then
      raise exception 'Answer is locked after follow-up generation' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;
create trigger answers_02_followup_lock
  before update on public.answers
  for each row execute function public.guard_question_followup_answer_lock();

create function public.guard_question_followup_question_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare root_id uuid;
begin
  if tg_op = 'UPDATE' then
    if old.question_kind <> 'followup'
      and (new.status is distinct from old.status or new.is_active_version is distinct from old.is_active_version) then
      if exists (
        select 1 from public.questions child
        where child.root_question_id = old.root_question_id and child.question_kind = 'followup'
      ) then
        raise exception 'Question is locked after follow-up generation' using errcode = '55000';
      end if;
    end if;
  elsif new.question_kind = 'followup' then
    if coalesce(auth.role(), '') <> 'service_role' then
      raise exception 'Only the trusted server can create follow-up questions' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.question_followup_requests r
      where r.session_id = new.session_id and r.root_question_id = new.root_question_id
        and r.parent_question_id = new.parent_question_id and r.status = 'dispatch_started'
    ) then
      raise exception 'Follow-up requires a dispatched generation request' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;
create trigger questions_followup_lock
  before insert or update on public.questions
  for each row execute function public.guard_question_followup_question_lock();

create function public.guard_question_followup_conflicting_action()
returns trigger language plpgsql security definer set search_path = '' as $$
declare root_id uuid; target_session uuid;
begin
  if tg_table_name = 'question_action_requests' then
    target_session := new.session_id;
    select root_question_id into root_id from public.questions
      where id = new.question_id and session_id = target_session;
  else
    target_session := new.session_id;
    select root_question_id into root_id from public.questions
      where id = new.question_id and session_id = target_session;
  end if;
  if exists (
    select 1 from public.questions child
    where child.session_id = target_session and child.root_question_id = root_id
      and child.question_kind = 'followup'
  ) then
    raise exception 'Question cannot be changed after follow-up generation' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger question_actions_followup_lock
  before insert on public.question_action_requests
  for each row execute function public.guard_question_followup_conflicting_action();
create trigger question_regeneration_followup_lock
  before insert on public.question_regeneration_requests
  for each row execute function public.guard_question_followup_conflicting_action();

create function public.begin_question_followup(
  p_session_id uuid, p_question_id uuid, p_request_id uuid, p_participant_id uuid,
  p_expected_answer_updated_at timestamptz, p_answer_hash text, p_answer_snapshot text,
  p_prompt_version text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.sessions%rowtype; q public.questions%rowtype; a public.answers%rowtype;
  r public.question_followup_requests%rowtype; selected_answer text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Trusted server required' using errcode = '42501';
  end if;
  select * into s from public.sessions where id = p_session_id for update;
  if not found or s.participant_id <> p_participant_id or s.status <> 'in_progress'
    or not exists (select 1 from public.profiles p where p.id = p_participant_id
      and p.role = 'participant' and p.status = 'active') then
    raise exception 'Active participant session required' using errcode = '42501';
  end if;
  select * into q from public.questions where id = p_question_id and session_id = p_session_id for update;
  if not found or q.question_kind not in ('original','regenerated') or not q.is_active_version
    or q.status <> 'answered' then
    raise exception 'Question is not eligible for follow-up' using errcode = '55000';
  end if;
  select * into a from public.answers where question_id = q.id for update;
  if not found or a.updated_at <> p_expected_answer_updated_at then
    raise exception 'Answer revision changed' using errcode = '40001';
  end if;
  selected_answer := case when a.current_answer_version = 'refined'
    then coalesce(a.refined_answer, '') else a.original_answer end;
  if selected_answer is distinct from p_answer_snapshot
    or length(btrim(selected_answer)) = 0 then
    raise exception 'Answer snapshot changed or is empty' using errcode = '40001';
  end if;
  select * into r from public.question_followup_requests
    where session_id = p_session_id and request_id = p_request_id;
  if found then
    if r.parent_question_id <> q.id or r.answer_hash <> p_answer_hash then
      raise exception 'Request identity changed' using errcode = '40001';
    end if;
    return jsonb_build_object('id', r.id, 'request_id', r.request_id, 'status', r.status,
      'result_question_id', r.result_question_id, 'answer_snapshot', r.answer_snapshot);
  end if;
  if exists (select 1 from public.questions child
      where child.root_question_id = q.root_question_id and child.question_kind = 'followup') then
    raise exception 'Follow-up already generated' using errcode = '54000';
  end if;
  select * into r from public.question_followup_requests
    where root_question_id = q.root_question_id and answer_hash = p_answer_hash
      and status in ('dispatch_started','no_followup','outcome_unknown');
  if found then
    return jsonb_build_object('id', r.id, 'request_id', r.request_id, 'status', r.status,
      'result_question_id', r.result_question_id, 'answer_snapshot', r.answer_snapshot);
  end if;
  select * into r from public.question_followup_requests
    where root_question_id = q.root_question_id and status in ('reserved','dispatch_started');
  if found then
    return jsonb_build_object('id', r.id, 'request_id', r.request_id, 'status', r.status,
      'result_question_id', r.result_question_id, 'answer_snapshot', r.answer_snapshot);
  end if;
  insert into public.question_followup_requests(
    session_id,participant_id,request_id,root_question_id,parent_question_id,
    expected_answer_updated_at,answer_hash,answer_snapshot,status,prompt_version
  ) values (
    p_session_id,p_participant_id,p_request_id,q.root_question_id,q.id,
    a.updated_at,p_answer_hash,selected_answer,'reserved',p_prompt_version
  ) returning * into r;
  return jsonb_build_object('id', r.id, 'request_id', r.request_id, 'status', r.status,
    'result_question_id', null, 'answer_snapshot', r.answer_snapshot);
end;
$$;

create function public.dispatch_question_followup(p_request_id uuid, p_model_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.question_followup_requests%rowtype; acquired boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Trusted server required' using errcode = '42501';
  end if;
  select * into r from public.question_followup_requests where id = p_request_id for update;
  if not found then raise exception 'Follow-up request not found' using errcode = 'P0002'; end if;
  if r.status = 'reserved' then
    update public.question_followup_requests set status='dispatch_started',
      model_id=p_model_id,dispatched_at=clock_timestamp() where id=r.id returning * into r;
    acquired := true;
    insert into public.question_events(session_id,question_id,participant_id,event_type,event_data)
      values(r.session_id,r.parent_question_id,r.participant_id,'followup_requested',
        jsonb_build_object('request_id',r.request_id,'status','dispatch_started',
          'answer_hash',r.answer_hash,'prompt_version',r.prompt_version));
  end if;
  return jsonb_build_object('request_id',r.request_id,'status',r.status,'acquired',acquired);
end;
$$;

create function public.finish_question_followup(
  p_request_id uuid, p_outcome text, p_question_text text, p_model_id text,
  p_input_tokens integer, p_output_tokens integer, p_failure_code text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.question_followup_requests%rowtype; q public.questions%rowtype;
  a public.answers%rowtype; s public.sessions%rowtype; child_id uuid;
  answer_text text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Trusted server required' using errcode = '42501';
  end if;
  select * into r from public.question_followup_requests where id=p_request_id for update;
  if not found then raise exception 'Follow-up request not found' using errcode = 'P0002'; end if;
  if r.status in ('generated','no_followup','failed','outcome_unknown')
    or (p_outcome='failed' and p_failure_code='FOLLOWUP-NOT-DISPATCHED'
      and r.status<>'reserved') then
    return jsonb_build_object('id',r.id,'request_id',r.request_id,'status',r.status,
      'result_question_id',r.result_question_id,'answer_snapshot',r.answer_snapshot);
  end if;
  if r.status <> 'dispatch_started'
    and not (r.status = 'reserved' and p_outcome = 'failed') then
    raise exception 'Follow-up dispatch required' using errcode = '55000';
  end if;
  if p_outcome not in ('generated','no_followup','failed','outcome_unknown') then
    raise exception 'Invalid follow-up result' using errcode = '22023';
  end if;
  select * into s from public.sessions where id=r.session_id for update;
  select * into q from public.questions where id=r.parent_question_id and session_id=r.session_id for update;
  select * into a from public.answers where question_id=r.parent_question_id for update;
  answer_text := case when a.current_answer_version='refined'
    then coalesce(a.refined_answer,'') else coalesce(a.original_answer,'') end;
  if p_outcome in ('generated','no_followup') and (
    s.status <> 'in_progress' or not q.is_active_version or q.status <> 'answered'
    or a.updated_at is distinct from r.expected_answer_updated_at
    or answer_text is distinct from r.answer_snapshot
    or exists (select 1 from public.questions existing
      where existing.root_question_id=r.root_question_id and existing.question_kind='followup')) then
    p_outcome := 'outcome_unknown';
    p_failure_code := 'FOLLOWUP-STALE';
  end if;
  if p_outcome='generated' then
    if p_question_text is null or length(btrim(p_question_text))=0 or length(p_question_text)>2000 then
      raise exception 'Invalid follow-up question' using errcode = '22023';
    end if;
    child_id := gen_random_uuid();
    insert into public.questions(
      id,session_id,root_question_id,parent_question_id,question_kind,slot_index,regeneration_index,
      followup_index,question_text,target_type,selection_reason,model_id,prompt_version,
      framework_version,generated_at,is_active_version
    ) values (
      child_id,r.session_id,r.root_question_id,r.parent_question_id,'followup',q.slot_index,null,
      1,btrim(p_question_text),q.target_type,'response_based_followup',p_model_id,r.prompt_version,
      'v1.0',clock_timestamp(),false
    );
    insert into public.question_targets(question_id,session_id,image_id,x,y,width,height,sort_order)
      select child_id,r.session_id,image_id,x,y,width,height,sort_order
      from public.question_targets where question_id=q.id;
  end if;
  update public.question_followup_requests set status=p_outcome,
    result_question_id=child_id,model_id=coalesce(p_model_id,model_id),
    input_tokens=p_input_tokens,output_tokens=p_output_tokens,
    failure_code=p_failure_code,finished_at=clock_timestamp()
    where id=r.id returning * into r;
  insert into public.question_events(session_id,question_id,participant_id,event_type,event_data)
    values(r.session_id,r.parent_question_id,r.participant_id,'followup_requested',
      jsonb_build_object('request_id',r.request_id,'outcome',r.status,
        'followup_question_id',r.result_question_id,'prompt_version',r.prompt_version,
        'model_id',r.model_id,'input_tokens',r.input_tokens,'output_tokens',r.output_tokens,
        'failure_code',r.failure_code));
  return jsonb_build_object('id',r.id,'request_id',r.request_id,'status',r.status,
    'result_question_id',r.result_question_id,'answer_snapshot',r.answer_snapshot);
end;
$$;

alter function public.guard_question_followup_history() owner to postgres;
alter function public.guard_question_followup_answer_lock() owner to postgres;
alter function public.guard_question_followup_question_lock() owner to postgres;
alter function public.guard_question_followup_conflicting_action() owner to postgres;
alter function public.begin_question_followup(uuid,uuid,uuid,uuid,timestamptz,text,text,text) owner to postgres;
alter function public.dispatch_question_followup(uuid,text) owner to postgres;
alter function public.finish_question_followup(uuid,text,text,text,integer,integer,text) owner to postgres;
revoke all on function public.guard_question_followup_history() from public, anon, authenticated, service_role;
revoke all on function public.guard_question_followup_answer_lock() from public, anon, authenticated, service_role;
revoke all on function public.guard_question_followup_question_lock() from public, anon, authenticated, service_role;
revoke all on function public.guard_question_followup_conflicting_action() from public, anon, authenticated, service_role;
revoke all on function public.begin_question_followup(uuid,uuid,uuid,uuid,timestamptz,text,text,text) from public, anon, authenticated;
revoke all on function public.dispatch_question_followup(uuid,text) from public, anon, authenticated;
revoke all on function public.finish_question_followup(uuid,text,text,text,integer,integer,text) from public, anon, authenticated;
grant execute on function public.begin_question_followup(uuid,uuid,uuid,uuid,timestamptz,text,text,text) to service_role;
grant execute on function public.dispatch_question_followup(uuid,text) to service_role;
grant execute on function public.finish_question_followup(uuid,text,text,text,integer,integer,text) to service_role;

commit;
