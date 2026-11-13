begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table public.answer_refinement_history (
  id bigint generated always as identity primary key,
  answer_id uuid not null references public.answers(id) on delete restrict,
  question_id uuid not null references public.questions(id) on delete restrict,
  participant_id uuid not null references public.profiles(id) on delete restrict,
  source_text text not null,
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  prompt_version text not null,
  model_id text not null,
  mode text not null check (mode in ('manual','automatic')),
  state text not null check (state in ('running','completed','failed')),
  result_text text,
  failure_code text,
  request_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  check ((state='running' and result_text is null and failure_code is null and finished_at is null)
    or (state='completed' and length(btrim(result_text))>0 and failure_code is null and finished_at is not null)
    or (state='failed' and result_text is null and failure_code is not null and finished_at is not null))
);
create unique index answer_refinement_automatic_once on public.answer_refinement_history
  (answer_id,source_hash,prompt_version) where mode='automatic';
alter table public.answer_refinement_history enable row level security;
revoke all on public.answer_refinement_history from public,anon,authenticated,service_role;
grant select on public.answer_refinement_history to authenticated;
create policy answer_refinement_history_owner on public.answer_refinement_history for select to authenticated
  using (participant_id=(select auth.uid()));

create table public.completion_refinement_progress (
  session_id uuid not null,
  request_id uuid not null,
  participant_id uuid not null references public.profiles(id) on delete restrict,
  phase text not null check (phase in ('refining','briefing')),
  failure_count integer not null default 0 check (failure_count>=0),
  primary key (session_id,request_id),
  foreign key (session_id,request_id) references public.session_briefing_requests(session_id,request_id) on delete restrict
);
alter table public.completion_refinement_progress enable row level security;
revoke all on public.completion_refinement_progress from public,anon,authenticated,service_role;
grant select on public.completion_refinement_progress to authenticated;
create policy completion_refinement_progress_owner on public.completion_refinement_progress for select to authenticated
  using (participant_id=(select auth.uid()));

create function public.completion_refinement_phase(p_session_id uuid,p_request_id uuid,p_participant_id uuid,p_phase text,p_failure_count integer)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' or p_phase not in ('refining','briefing') or p_failure_count<0 then
    raise exception 'Trusted completion phase required' using errcode='42501';
  end if;
  if not exists(select 1 from public.session_briefing_requests where session_id=p_session_id and
    request_id=p_request_id and participant_id=p_participant_id and state='dispatch_started') then
    raise exception 'Active completion request required' using errcode='55000';
  end if;
  insert into public.completion_refinement_progress(session_id,request_id,participant_id,phase,failure_count)
    values(p_session_id,p_request_id,p_participant_id,p_phase,p_failure_count)
    on conflict(session_id,request_id) do update set phase=excluded.phase,failure_count=excluded.failure_count;
end $$;
revoke all on function public.completion_refinement_phase(uuid,uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.completion_refinement_phase(uuid,uuid,uuid,text,integer) to service_role;

create function public.claim_completion_refinement(
  p_session_id uuid,p_request_id uuid,p_participant_id uuid,p_question_id uuid,
  p_source text,p_source_hash text,p_prompt_version text,p_model text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.answers%rowtype; q public.questions%rowtype; r public.answer_refinement_history%rowtype;
  snap jsonb; found_answer jsonb; hash text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted completion server required' using errcode='42501';
  end if;
  select input_snapshot into snap from public.session_briefing_requests where session_id=p_session_id
    and request_id=p_request_id and participant_id=p_participant_id and state='dispatch_started';
  if not found then raise exception 'Active completion request required' using errcode='55000'; end if;
  select q1.* into q from public.questions q1 where q1.id=p_question_id and q1.session_id=p_session_id;
  select a1.* into a from public.answers a1 where a1.question_id=p_question_id and a1.participant_id=p_participant_id;
  if q.id is null or a.id is null or q.status<>'answered' then
    raise exception 'Saved answer required' using errcode='55000';
  end if;
  select item->'answer' into found_answer from jsonb_array_elements(snap->'answered_questions') item
    where item->>'question_id'=p_question_id::text;
  if found_answer is null then
    select item->'followup'->'answer' into found_answer
      from jsonb_array_elements(snap->'answered_questions') item
      where item->'followup'->>'question_id'=p_question_id::text;
  end if;
  hash:=encode(sha256(convert_to(p_source,'UTF8')),'hex');
  if found_answer is null or found_answer->>'current_version'<>'original' or
    found_answer->>'original' is distinct from p_source or p_source is distinct from a.original_answer or
    hash is distinct from p_source_hash or length(btrim(p_source))=0 or
    length(p_source)>20000 or length(btrim(p_prompt_version))=0 or length(btrim(p_model))=0 then
    raise exception 'Invalid refinement source' using errcode='22023';
  end if;
  if q.answer_form->>'kind'='choice' and (
    found_answer->'choice_selection' is null or
    jsonb_array_length(found_answer->'choice_selection'->'selected_options')<>0 or
    coalesce(found_answer->'choice_selection'->>'explanation','')<>'' or
    found_answer->'choice_selection'->>'other' is distinct from p_source) then
    raise exception 'Only direct choice writing can be refined' using errcode='22023';
  end if;
  select * into r from public.answer_refinement_history where answer_id=a.id and source_hash=hash
    and source_text=p_source and mode='manual' and state='completed'
    order by finished_at desc,id desc limit 1;
  if found then return jsonb_build_object('state','completed','result',r.result_text); end if;
  insert into public.answer_refinement_history(answer_id,question_id,participant_id,source_text,source_hash,
    prompt_version,model_id,mode,state,request_id)
    values(a.id,p_question_id,p_participant_id,p_source,hash,p_prompt_version,p_model,'automatic','running',p_request_id)
    on conflict(answer_id,source_hash,prompt_version) where mode='automatic' do nothing
    returning * into r;
  if found then return jsonb_build_object('state','claimed','id',r.id); end if;
  select * into r from public.answer_refinement_history where answer_id=a.id and source_hash=hash
    and prompt_version=p_prompt_version and mode='automatic';
  if r.source_text is distinct from p_source then raise exception 'Source hash mismatch' using errcode='22023'; end if;
  return jsonb_build_object('state',r.state,'result',r.result_text);
end $$;
revoke all on function public.claim_completion_refinement(uuid,uuid,uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.claim_completion_refinement(uuid,uuid,uuid,uuid,text,text,text,text) to service_role;

create function public.finish_completion_refinement(p_id bigint,p_session_id uuid,p_request_id uuid,
  p_participant_id uuid,p_result text,p_failure_code text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' or
    ((p_result is null)=(p_failure_code is null)) or
    (p_result is not null and (length(btrim(p_result))=0 or length(p_result)>20000)) then
    raise exception 'Invalid refinement outcome' using errcode='22023';
  end if;
  update public.answer_refinement_history h set
    state=case when p_result is null then 'failed' else 'completed' end,
    result_text=p_result,failure_code=p_failure_code,finished_at=clock_timestamp()
    where h.id=p_id and h.request_id=p_request_id and h.participant_id=p_participant_id and h.state='running'
      and exists(select 1 from public.session_briefing_requests b where b.session_id=p_session_id
        and b.request_id=p_request_id and b.participant_id=p_participant_id and b.state='dispatch_started');
  if not found then raise exception 'Refinement claim is not active' using errcode='55000'; end if;
end $$;
revoke all on function public.finish_completion_refinement(bigint,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.finish_completion_refinement(bigint,uuid,uuid,uuid,text,text) to service_role;

create function public.record_manual_answer_refinement() returns trigger
language plpgsql security definer set search_path='' as $$
declare provenance jsonb; source text;
begin
  provenance:=nullif(current_setting('why_box.manual_refinement',true),'')::jsonb;
  if (new.refined_answer is distinct from old.refined_answer or provenance is not null) and new.refined_answer is not null
    and length(btrim(new.refined_answer))>0 and new.original_answer=old.original_answer then
    source:=coalesce(provenance->>'source',new.original_answer);
    insert into public.answer_refinement_history(answer_id,question_id,participant_id,source_text,source_hash,
      prompt_version,model_id,mode,state,result_text,finished_at)
    values(new.id,new.question_id,new.participant_id,source,
      encode(sha256(convert_to(source,'UTF8')),'hex'),
      coalesce(provenance->>'prompt_version','user-edited-or-legacy'),
      coalesce(provenance->>'model_id','user-edited-or-unknown'),'manual','completed',new.refined_answer,clock_timestamp());
  end if;
  return new;
end $$;
revoke all on function public.record_manual_answer_refinement() from public,anon,authenticated,service_role;
create trigger answers_record_manual_refinement after update on public.answers
  for each row execute function public.record_manual_answer_refinement();

create function public.save_manual_answer_refinement(p_question_id uuid,p_participant_id uuid,
  p_expected_updated_at timestamptz,p_source text,p_result text,p_prompt_version text,p_model text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.answers%rowtype;
begin
  if auth.role() is distinct from 'service_role' or length(btrim(coalesce(p_result,'')))=0 or
    length(p_result)>20000 or length(btrim(coalesce(p_prompt_version,'')))=0 or length(btrim(coalesce(p_model,'')))=0 then
    raise exception 'Trusted manual refinement required' using errcode='42501';
  end if;
  perform 1 from public.questions q join public.sessions s on s.id=q.session_id
    where q.id=p_question_id and s.participant_id=p_participant_id and s.status='in_progress'
      and q.status<>'skipped' and (q.is_active_version or q.question_kind='followup')
      and (q.question_kind='followup' or not exists(select 1 from public.questions child
        where child.parent_question_id=q.id and child.question_kind='followup'))
    for update of s,q;
  if not found then raise exception 'Answer is not editable' using errcode='55000'; end if;
  perform set_config('why_box.manual_refinement',jsonb_build_object('prompt_version',p_prompt_version,'model_id',p_model,'source',p_source)::text,true);
  update public.answers set refined_answer=p_result,refinement_used=true,refined_at=clock_timestamp(),
    current_answer_version='refined'
    where question_id=p_question_id and participant_id=p_participant_id and updated_at=p_expected_updated_at
      and (case when current_answer_version='refined' then refined_answer else original_answer end)=p_source
    returning * into a;
  perform set_config('why_box.manual_refinement','',true);
  if a.id is null then return null; end if;
  return jsonb_build_object('updated_at',a.updated_at);
end $$;
revoke all on function public.save_manual_answer_refinement(uuid,uuid,timestamptz,text,text,text,text) from public,anon,authenticated;
grant execute on function public.save_manual_answer_refinement(uuid,uuid,timestamptz,text,text,text,text) to service_role;

notify pgrst,'reload schema';
commit;
