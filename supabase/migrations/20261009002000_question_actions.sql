-- Local only: Production deployment requires separate approval.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

create table public.question_action_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete restrict,
  participant_id uuid not null references public.profiles(id) on delete restrict,
  request_id uuid not null,
  question_id uuid not null,
  action text not null check (action in ('skip','regenerate')),
  expected_answer_revision timestamptz,
  result_question_id uuid not null,
  created_at timestamptz not null default now(),
  unique(session_id,request_id),
  foreign key (question_id,session_id) references public.questions(id,session_id) on delete restrict,
  foreign key (result_question_id,session_id) references public.questions(id,session_id) on delete restrict
);
alter table public.question_action_requests enable row level security;
revoke all on public.question_action_requests from public,anon,authenticated,service_role;
grant select on public.question_action_requests to authenticated,service_role;
create policy question_action_requests_select_owner_or_admin on public.question_action_requests
  for select to authenticated using (public.owns_session(session_id) or public.is_active_admin());
create function public.guard_question_action_history()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'Question action history is immutable' using errcode='42501';
end;
$$;
create trigger question_action_history_guard before update or delete on public.question_action_requests
  for each row execute function public.guard_question_action_history();

create unique index questions_all_candidate_unique on public.questions(source_candidate_id)
  where source_candidate_id is not null;

create or replace function public.guard_question_generation_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'Generation history cannot be deleted' using errcode = '42501'; end if;
  if tg_table_name = 'question_candidates' then
    if tg_op = 'UPDATE' then raise exception 'Candidates are immutable' using errcode = '42501'; end if;
    if not exists (select 1 from public.question_generation_attempts a where a.id = new.attempt_id
      and a.session_id = new.session_id and a.status = 'running' and a.validated_candidates is not null) then
      raise exception 'Candidate requires a validated running attempt' using errcode = '42501';
    end if;
  elsif tg_table_name = 'questions' then
    if tg_op = 'INSERT' and public.question_generation_has_running(new.session_id) and new.source_candidate_id is null then
      raise exception 'Running initial generation requires candidate provenance' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.source_candidate_id is distinct from old.source_candidate_id then
      raise exception 'Question provenance is immutable' using errcode = '42501';
    end if;
    if tg_op = 'INSERT' and new.source_candidate_id is not null then
      if new.question_kind='regenerated' then
        if coalesce(auth.role(),'')<>'service_role' or not exists (
          select 1 from public.question_candidates c
          join public.question_generation_attempts a on a.id=c.attempt_id
          join public.questions root on root.id=new.root_question_id
          join public.question_candidates initial on initial.id=root.source_candidate_id
          where c.id=new.source_candidate_id and c.session_id=new.session_id
            and initial.attempt_id=c.attempt_id and a.status='completed'
            and c.candidate_rank>a.requested_question_count
            and c.question_text=new.question_text and c.content_principle=new.content_principle
            and c.question_type=new.detail_type and c.target->>'type'=new.target_type
            and c.model_id=new.model_id and c.prompt_version=new.prompt_version
            and c.framework_version=new.framework_version and c.generated_at=new.generated_at
            and new.selection_reason='system:reserve_replacement;candidate_rank=' || c.candidate_rank ||
              ';slot_index=' || new.slot_index
        ) then raise exception 'Invalid reserve candidate provenance' using errcode='22023'; end if;
      elsif new.question_kind <> 'original' or not exists (
        select 1 from public.question_candidates c join public.question_generation_attempts a on a.id = c.attempt_id
        where c.id = new.source_candidate_id and c.session_id = new.session_id and c.candidate_rank = new.slot_index
          and c.candidate_rank <= a.requested_question_count and a.status = 'running'
          and c.question_text = new.question_text and c.content_principle = new.content_principle
          and c.question_type = new.detail_type and c.target->>'type' = new.target_type
          and c.model_id = new.model_id and c.prompt_version = new.prompt_version
          and c.framework_version = new.framework_version and c.generated_at = new.generated_at
          and new.selection_reason = 'system:initial_top_n;candidate_rank=' || c.candidate_rank ||
            ';requested_question_count=' || a.requested_question_count
      ) then raise exception 'Invalid original candidate provenance' using errcode = '22023'; end if;
    end if;
  elsif tg_op = 'UPDATE' then
    if old.status <> 'running' or new.id <> old.id or new.session_id <> old.session_id
      or new.request_id <> old.request_id or new.input_snapshot <> old.input_snapshot
      or new.image_snapshot <> old.image_snapshot or new.requested_question_count <> old.requested_question_count
      or new.started_at <> old.started_at or (old.validated_candidates is not null and (
        new.validated_candidates is distinct from old.validated_candidates or new.model_id is distinct from old.model_id
        or new.prompt_version is distinct from old.prompt_version or new.schema_version is distinct from old.schema_version
        or new.framework_version is distinct from old.framework_version or new.generated_at is distinct from old.generated_at
      )) then raise exception 'Generation attempt history is immutable' using errcode = '42501'; end if;
    if new.status = 'completed' and (
      (select count(*) from public.question_candidates c where c.attempt_id=new.id) <> 5
      or (select count(*) from public.questions q join public.question_candidates c on c.id=q.source_candidate_id
        where c.attempt_id=new.id and q.question_kind='original') <> new.requested_question_count
      or not exists(select 1 from public.sessions s where s.id=new.session_id and s.status='in_progress')
    ) then raise exception 'Incomplete generation cannot complete' using errcode = '23514'; end if;
  end if;
  return new;
end;
$$;

create function public.read_question_action_capabilities(p_session_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_count integer;
begin
  if not public.owns_session(p_session_id) then
    raise exception 'Participant ownership required' using errcode='42501';
  end if;
  select count(*)::integer into v_count from public.question_candidates c
    join public.question_generation_attempts a on a.id=c.attempt_id
    where c.session_id=p_session_id and a.status='completed' and c.candidate_rank>a.requested_question_count
      and not exists(select 1 from public.questions q where q.source_candidate_id=c.id);
  return jsonb_build_object('ready',true,'reserve_count',v_count);
end;
$$;

create function public.apply_question_action(p_session_id uuid,p_question_id uuid,p_request_id uuid,
  p_action text,p_participant_id uuid,p_expected_answer_revision timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_session public.sessions%rowtype;
  v_question public.questions%rowtype;
  v_answer public.answers%rowtype;
  v_request public.question_action_requests%rowtype;
  v_candidate public.question_candidates%rowtype;
  v_attempt public.question_generation_attempts%rowtype;
  v_new_id uuid;
  v_image_index integer;
  v_target_order integer:=0;
  v_region jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Trusted server required' using errcode='42501';
  end if;
  if p_action is null or p_action not in ('skip','regenerate') or p_request_id is null then
    raise exception 'Invalid action' using errcode='22023';
  end if;
  select * into v_session from public.sessions where id=p_session_id for update;
  if not found or v_session.participant_id<>p_participant_id then
    raise exception 'Participant ownership required' using errcode='42501';
  end if;
  perform 1 from public.profiles where id=p_participant_id and role='participant' and status='active' for share;
  if not found then raise exception 'Active Participant required' using errcode='42501'; end if;
  select * into v_request from public.question_action_requests
    where session_id=p_session_id and request_id=p_request_id;
  if found then
    if v_request.question_id<>p_question_id or v_request.action<>p_action or v_request.participant_id<>p_participant_id
      or v_request.expected_answer_revision is distinct from p_expected_answer_revision then
      raise exception 'Request identity changed' using errcode='40001';
    end if;
    return jsonb_build_object('request_id',p_request_id,'question_id',p_question_id,
      'result_question_id',v_request.result_question_id,'changed',false);
  end if;
  if v_session.status<>'in_progress' or public.question_generation_has_running(p_session_id) then
    raise exception 'Session is read-only' using errcode='55000';
  end if;
  select * into v_question from public.questions where id=p_question_id and session_id=p_session_id for update;
  if not found then raise exception 'Question not found' using errcode='42501'; end if;
  if not v_question.is_active_version or v_question.question_kind not in ('original','regenerated') then
    raise exception 'Question version changed' using errcode='40001';
  end if;
  select * into v_answer from public.answers where question_id=p_question_id for update;
  if v_answer.updated_at is distinct from p_expected_answer_revision then
    raise exception 'Answer revision changed' using errcode='40001';
  end if;
  if v_question.status='answered' or length(btrim(coalesce(v_answer.original_answer,'')))>0
    or length(btrim(coalesce(v_answer.refined_answer,'')))>0 then
    raise exception 'Written answers must be preserved' using errcode='55000';
  end if;
  if p_action='skip' then
    if v_question.status='skipped' then
      insert into public.question_action_requests(session_id,participant_id,request_id,question_id,action,
        expected_answer_revision,result_question_id)
        values(p_session_id,p_participant_id,p_request_id,p_question_id,p_action,p_expected_answer_revision,p_question_id);
      return jsonb_build_object('request_id',p_request_id,'question_id',p_question_id,
        'result_question_id',p_question_id,'changed',false);
    end if;
    update public.questions set status='skipped',skipped_at=clock_timestamp() where id=p_question_id;
    v_new_id:=p_question_id;
  else
    if v_question.regeneration_index>=2 then
      raise exception 'Regeneration limit reached' using errcode='54000';
    end if;
    select c.* into v_candidate from public.question_candidates c
      join public.question_generation_attempts a on a.id=c.attempt_id
      join public.questions root on root.id=v_question.root_question_id
      join public.question_candidates initial on initial.id=root.source_candidate_id
      where c.session_id=p_session_id and c.attempt_id=initial.attempt_id and a.status='completed'
        and c.candidate_rank>a.requested_question_count
        and not exists(select 1 from public.questions q where q.source_candidate_id=c.id)
      order by c.candidate_rank limit 1 for update of c;
    if not found then raise exception 'No unused reserve candidate' using errcode='P0002'; end if;
    select * into v_attempt from public.question_generation_attempts where id=v_candidate.attempt_id;
    v_new_id:=gen_random_uuid();
    update public.questions set is_active_version=false where id=p_question_id;
    insert into public.questions(id,session_id,root_question_id,parent_question_id,question_kind,
      slot_index,regeneration_index,question_text,content_principle,detail_type,target_type,
      selection_reason,model_id,prompt_version,framework_version,generated_at,source_candidate_id)
    values(v_new_id,p_session_id,v_question.root_question_id,p_question_id,'regenerated',
      v_question.slot_index,v_question.regeneration_index+1,v_candidate.question_text,v_candidate.content_principle,
      v_candidate.question_type,v_candidate.target->>'type',
      'system:reserve_replacement;candidate_rank=' || v_candidate.candidate_rank || ';slot_index=' || v_question.slot_index,
      v_candidate.model_id,v_candidate.prompt_version,v_candidate.framework_version,v_candidate.generated_at,v_candidate.id);
    v_region:=v_candidate.target->'region';
    for v_image_index in select value::integer from jsonb_array_elements_text(v_candidate.target->'image_indices') loop
      insert into public.question_targets(question_id,session_id,image_id,x,y,width,height,sort_order)
      values(v_new_id,p_session_id,(v_attempt.image_snapshot->(v_image_index-1)->>'id')::uuid,
        (v_region->>'x')::double precision,(v_region->>'y')::double precision,
        (v_region->>'width')::double precision,(v_region->>'height')::double precision,v_target_order);
      v_target_order:=v_target_order+1;
    end loop;
  end if;
  insert into public.question_events(session_id,question_id,participant_id,event_type,event_data)
    values(p_session_id,p_question_id,p_participant_id,
      case when p_action='skip' then 'question_skipped' else 'question_regenerated' end,
      jsonb_build_object('request_id',p_request_id,'result_question_id',v_new_id,'slot_index',v_question.slot_index,
        'source_candidate_id',case when p_action='regenerate' then v_candidate.id else null end));
  insert into public.question_action_requests(session_id,participant_id,request_id,question_id,action,
    expected_answer_revision,result_question_id)
    values(p_session_id,p_participant_id,p_request_id,p_question_id,p_action,p_expected_answer_revision,v_new_id);
  return jsonb_build_object('request_id',p_request_id,'question_id',p_question_id,
    'result_question_id',v_new_id,'changed',true);
end;
$$;

alter table public.question_action_requests owner to postgres;
alter function public.guard_question_action_history() owner to postgres;
alter function public.read_question_action_capabilities(uuid) owner to postgres;
alter function public.apply_question_action(uuid,uuid,uuid,text,uuid,timestamptz) owner to postgres;
revoke all on function public.guard_question_action_history() from public,anon,authenticated,service_role;
revoke all on function public.read_question_action_capabilities(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_question_action_capabilities(uuid) to authenticated;
revoke all on function public.apply_question_action(uuid,uuid,uuid,text,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.apply_question_action(uuid,uuid,uuid,text,uuid,timestamptz) to service_role;
commit;
