-- Additive/local-only Phase3-D-4-B. No provider work occurs inside these transactions.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

create table public.question_regeneration_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete restrict,
  participant_id uuid not null references public.profiles(id) on delete restrict,
  request_id uuid not null,
  question_id uuid not null,
  expected_answer_revision timestamptz,
  allow_api boolean not null,
  policy_version text not null default 'phase3-d-4-b-v1' check (policy_version='phase3-d-4-b-v1'),
  status text not null check (status in ('reserved','dispatch_started','staged','completed','failed','dispatch_unknown')),
  method text not null check (method in ('reserve','api_generated')),
  result_question_id uuid,
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  unique(session_id,request_id),
  unique(id,session_id),
  foreign key(question_id,session_id) references public.questions(id,session_id) on delete restrict,
  foreign key(result_question_id,session_id) references public.questions(id,session_id) on delete restrict,
  check ((status='completed') = (result_question_id is not null)),
  check ((status in ('completed','failed','dispatch_unknown')) = (finished_at is not null))
);
create unique index question_regeneration_one_pending on public.question_regeneration_requests(session_id)
  where status in ('reserved','dispatch_started','staged');

create table public.question_regeneration_attempts (
  id uuid primary key default gen_random_uuid(),
  regeneration_request_id uuid not null unique,
  session_id uuid not null,
  root_question_id uuid not null,
  input_snapshot jsonb not null,
  image_snapshot jsonb not null,
  exclusion_snapshot jsonb not null,
  reserved_at timestamptz not null default clock_timestamp(),
  reserved_expires_at timestamptz not null default (clock_timestamp()+interval '2 minutes'),
  dispatched_at timestamptz,
  dispatch_expires_at timestamptz,
  unique(id,session_id),
  foreign key(regeneration_request_id,session_id) references public.question_regeneration_requests(id,session_id) on delete restrict,
  foreign key(root_question_id,session_id) references public.questions(id,session_id) on delete restrict,
  check ((dispatched_at is null) = (dispatch_expires_at is null))
);
create table public.question_regeneration_candidates (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique,
  session_id uuid not null,
  candidate jsonb not null check (jsonb_typeof(candidate)='object'),
  model_id text not null check (length(btrim(model_id)) between 1 and 200),
  prompt_version text not null check (length(btrim(prompt_version)) between 1 and 200),
  schema_version text not null check (length(btrim(schema_version)) between 1 and 200),
  framework_version text not null check (length(btrim(framework_version)) between 1 and 200),
  generated_at timestamptz not null,
  staged_at timestamptz not null default clock_timestamp(),
  unique(id,session_id),
  foreign key(attempt_id,session_id) references public.question_regeneration_attempts(id,session_id) on delete restrict
);
create table public.question_regeneration_events (
  id uuid primary key default gen_random_uuid(),
  regeneration_request_id uuid not null,
  session_id uuid not null,
  event_type text not null check (event_type in ('reserved','dispatch_started','staged','completed','failed','dispatch_unknown')),
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(regeneration_request_id,session_id) references public.question_regeneration_requests(id,session_id) on delete restrict
);
alter table public.questions add column source_regeneration_candidate_id uuid;
alter table public.questions add constraint questions_regeneration_candidate_fk
  foreign key(source_regeneration_candidate_id,session_id) references public.question_regeneration_candidates(id,session_id) on delete restrict;
alter table public.questions add constraint questions_exclusive_candidate_source
  check (source_candidate_id is null or source_regeneration_candidate_id is null);
create unique index questions_regeneration_candidate_unique on public.questions(source_regeneration_candidate_id)
  where source_regeneration_candidate_id is not null;

-- Snapshots never contain signed URLs/provider secrets and are not granted to clients.
create function public.question_regeneration_snapshot(p_session_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select public.question_generation_snapshot(p_session_id) || jsonb_build_object('exclusions',
    coalesce((select jsonb_agg(jsonb_build_object(
      'id',q.id,'root_question_id',q.root_question_id,'parent_question_id',q.parent_question_id,
      'question_text',q.question_text,'slot_index',q.slot_index,'regeneration_index',q.regeneration_index,
      'status',q.status,'is_active_version',q.is_active_version,
      'targets',coalesce((select jsonb_agg(to_jsonb(t) order by t.sort_order,t.id)
        from public.question_targets t where t.question_id=q.id),'[]'::jsonb)
    ) order by q.slot_index,q.regeneration_index,q.id) from public.questions q
      where q.session_id=p_session_id),'[]'::jsonb));
$$;

create function public.guard_question_regeneration_history()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or tg_table_name in ('question_regeneration_candidates','question_regeneration_events') then
    raise exception 'Regeneration history is immutable' using errcode='42501';
  end if;
  if tg_table_name='question_regeneration_requests' then
    if (to_jsonb(new)-array['status','result_question_id','error_code','finished_at'])
      is distinct from (to_jsonb(old)-array['status','result_question_id','error_code','finished_at'])
      or not ((old.status='reserved' and new.status in ('dispatch_started','failed'))
        or (old.status='dispatch_started' and new.status in ('staged','failed','dispatch_unknown'))
        or (old.status='staged' and new.status in ('completed','failed'))) then
      raise exception 'Invalid regeneration transition' using errcode='42501';
    end if;
  elsif (to_jsonb(new)-array['dispatched_at','dispatch_expires_at'])
    is distinct from (to_jsonb(old)-array['dispatched_at','dispatch_expires_at'])
    or old.dispatched_at is not null or new.dispatched_at is null then
    raise exception 'Dispatch history is immutable' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger question_regeneration_requests_history before update or delete on public.question_regeneration_requests
  for each row execute function public.guard_question_regeneration_history();
create trigger question_regeneration_attempts_history before update or delete on public.question_regeneration_attempts
  for each row execute function public.guard_question_regeneration_history();
create trigger question_regeneration_candidates_history before update or delete on public.question_regeneration_candidates
  for each row execute function public.guard_question_regeneration_history();
create trigger question_regeneration_events_history before update or delete on public.question_regeneration_events
  for each row execute function public.guard_question_regeneration_history();

create function public.guard_question_regeneration_provenance()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' then
    if new.source_regeneration_candidate_id is distinct from old.source_regeneration_candidate_id then
      raise exception 'Regeneration provenance is immutable' using errcode='42501';
    end if;
  elsif new.source_regeneration_candidate_id is not null then
    if coalesce(auth.role(),'')<>'service_role' or new.question_kind<>'regenerated' or not exists(
      select 1 from public.question_regeneration_candidates c
      join public.question_regeneration_attempts a on a.id=c.attempt_id
      join public.question_regeneration_requests r on r.id=a.regeneration_request_id
      where c.id=new.source_regeneration_candidate_id and c.session_id=new.session_id
        and r.status='staged' and r.question_id=new.parent_question_id and a.root_question_id=new.root_question_id
        and c.candidate->>'question_text'=new.question_text
        and c.candidate->>'content_principle'=new.content_principle
        and c.candidate->>'question_type'=new.detail_type and c.candidate->'target'->>'type'=new.target_type
        and c.model_id=new.model_id and c.prompt_version=new.prompt_version
        and c.framework_version=new.framework_version and c.generated_at=new.generated_at
        and new.selection_reason='system:api_regeneration;candidate_id='||c.id||';slot_index='||new.slot_index
    ) then raise exception 'Invalid API candidate provenance' using errcode='22023'; end if;
  end if;
  return new;
end;
$$;
create trigger questions_regeneration_provenance before insert or update on public.questions
  for each row execute function public.guard_question_regeneration_provenance();

-- Existing child guards lock session first. Hold only the target answer/action during the lease.
create function public.guard_question_regeneration_pending_write()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_session uuid; v_question uuid;
begin
  if tg_table_name='answers' then v_question:=new.question_id;
  else v_question:=new.id; end if;
  if tg_table_name='question_action_requests' then
    v_session:=new.session_id;
    perform 1 from public.sessions where id=v_session for update;
    if exists(select 1 from public.question_regeneration_requests r where r.session_id=v_session
      and r.request_id=new.request_id and (r.question_id<>new.question_id or new.action<>'regenerate'
        or r.participant_id<>new.participant_id or r.expected_answer_revision is distinct from new.expected_answer_revision)) then
      raise exception 'Request identity changed' using errcode='40001';
    end if;
    if exists(select 1 from public.question_regeneration_requests r where r.session_id=v_session
      and r.request_id=new.request_id and not (
        r.status='staged' and exists(
          select 1 from public.questions q join public.question_regeneration_candidates c on c.id=q.source_regeneration_candidate_id
          join public.question_regeneration_attempts a on a.id=c.attempt_id
          where q.id=new.result_question_id and a.regeneration_request_id=r.id))) then
      raise exception 'Request identity already admitted' using errcode='40001';
    end if;
    if exists(select 1 from public.question_regeneration_requests r where r.session_id=v_session
      and r.status in ('reserved','dispatch_started','staged') and not (
        r.request_id=new.request_id and r.status='staged' and exists(
          select 1 from public.questions q join public.question_regeneration_candidates c on c.id=q.source_regeneration_candidate_id
          join public.question_regeneration_attempts a on a.id=c.attempt_id
          where q.id=new.result_question_id and a.regeneration_request_id=r.id))) then
      raise exception 'Regeneration pending' using errcode='55P03';
    end if;
  else
    select q.session_id into v_session from public.questions q where q.id=v_question;
    perform 1 from public.sessions where id=v_session for update;
    if exists(select 1 from public.question_regeneration_requests r where r.session_id=v_session
      and r.question_id=v_question and r.status in ('reserved','dispatch_started','staged')) then
      if tg_table_name='answers' then
        raise exception 'Regeneration pending' using errcode='55P03';
      elsif new.status is distinct from old.status then
        raise exception 'Regeneration pending' using errcode='55P03';
      end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger answers_01_regeneration_pending before insert or update on public.answers
  for each row execute function public.guard_question_regeneration_pending_write();
create trigger questions_regeneration_pending before update on public.questions
  for each row execute function public.guard_question_regeneration_pending_write();
create trigger question_actions_regeneration_pending before insert on public.question_action_requests
  for each row execute function public.guard_question_regeneration_pending_write();

create function public.question_regeneration_result(p_id uuid,p_acquired boolean default false,p_changed boolean default false)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('request_id',r.request_id,'question_id',r.question_id,'status',r.status,
    'acquired',p_acquired,'attempt_id',a.id,'result_question_id',r.result_question_id,
    'changed',p_changed,'method',r.method,'error_code',r.error_code)
  from public.question_regeneration_requests r left join public.question_regeneration_attempts a
    on a.regeneration_request_id=r.id where r.id=p_id;
$$;

create function public.begin_question_regeneration(p_session_id uuid,p_question_id uuid,p_request_id uuid,
  p_participant_id uuid,p_expected_answer_revision timestamptz,p_allow_api boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.sessions%rowtype; q public.questions%rowtype; ans public.answers%rowtype;
  r public.question_regeneration_requests%rowtype; action public.question_action_requests%rowtype;
  snap jsonb; result jsonb; rid uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Trusted server required' using errcode='42501'; end if;
  if p_request_id is null or p_allow_api is null then raise exception 'Invalid request' using errcode='22023'; end if;
  select * into s from public.sessions where id=p_session_id for update;
  if not found or s.participant_id<>p_participant_id then raise exception 'Participant ownership required' using errcode='42501'; end if;
  perform 1 from public.profiles where id=p_participant_id and role='participant' and status='active' for share;
  if not found then raise exception 'Active Participant required' using errcode='42501'; end if;
  select * into r from public.question_regeneration_requests where session_id=p_session_id and request_id=p_request_id;
  if found then
    if r.question_id<>p_question_id or r.participant_id<>p_participant_id
      or r.expected_answer_revision is distinct from p_expected_answer_revision or r.allow_api<>p_allow_api then
      raise exception 'Request identity changed' using errcode='40001';
    end if;
    return public.question_regeneration_result(r.id);
  end if;
  select * into action from public.question_action_requests where session_id=p_session_id and request_id=p_request_id;
  if found then
    if action.question_id<>p_question_id or action.action<>'regenerate' or action.participant_id<>p_participant_id
      or action.expected_answer_revision is distinct from p_expected_answer_revision then
      raise exception 'Request identity changed' using errcode='40001';
    end if;
    return jsonb_build_object('request_id',p_request_id,'question_id',p_question_id,'status','completed',
      'acquired',false,'attempt_id',null,'result_question_id',action.result_question_id,'changed',false,'method','reserve');
  end if;
  if exists(select 1 from public.question_regeneration_requests where session_id=p_session_id
    and status in ('reserved','dispatch_started','staged')) then raise exception 'Regeneration pending' using errcode='55P03'; end if;
  if s.status<>'in_progress' or public.question_generation_has_running(s.id) then raise exception 'Session read-only' using errcode='55000'; end if;
  select * into q from public.questions where id=p_question_id and session_id=s.id for update;
  if not found or not q.is_active_version or q.question_kind not in ('original','regenerated') then
    raise exception 'Question version changed' using errcode='40001';
  end if;
  perform 1 from public.questions where id=q.root_question_id and session_id=s.id for update;
  select * into ans from public.answers where question_id=q.id for update;
  if ans.updated_at is distinct from p_expected_answer_revision then raise exception 'Answer revision changed' using errcode='40001'; end if;
  if q.status='answered' or length(btrim(coalesce(ans.original_answer,'')))>0 or length(btrim(coalesce(ans.refined_answer,'')))>0 then
    raise exception 'Written answers must be preserved' using errcode='55000';
  end if;
  if q.regeneration_index>=2 then raise exception 'Regeneration limit reached' using errcode='54000'; end if;
  if exists(select 1 from public.question_candidates c join public.question_generation_attempts a on a.id=c.attempt_id
    join public.questions root on root.id=q.root_question_id join public.question_candidates initial on initial.id=root.source_candidate_id
    where c.attempt_id=initial.attempt_id and a.status='completed' and c.candidate_rank>a.requested_question_count
      and not exists(select 1 from public.questions used where used.source_candidate_id=c.id)) then
    result:=public.apply_question_action(s.id,q.id,p_request_id,'regenerate',p_participant_id,p_expected_answer_revision);
    insert into public.question_regeneration_requests(session_id,participant_id,request_id,question_id,
      expected_answer_revision,allow_api,status,method,result_question_id,finished_at)
    values(s.id,p_participant_id,p_request_id,q.id,p_expected_answer_revision,p_allow_api,'completed','reserve',
      (result->>'result_question_id')::uuid,clock_timestamp()) returning id into rid;
    insert into public.question_regeneration_events(regeneration_request_id,session_id,event_type) values(rid,s.id,'completed');
    return public.question_regeneration_result(rid,false,true);
  end if;
  if not p_allow_api then raise exception 'No unused reserve candidate' using errcode='P0002'; end if;
  if (select count(*) from public.question_regeneration_attempts where session_id=s.id and dispatched_at is not null)>=3 then
    raise exception 'API dispatch limit reached' using errcode='54000';
  end if;
  snap:=public.question_regeneration_snapshot(s.id);
  if jsonb_array_length(snap->'images') not between 1 and 10 then raise exception 'Images required' using errcode='22023'; end if;
  insert into public.question_regeneration_requests(session_id,participant_id,request_id,question_id,
    expected_answer_revision,allow_api,status,method)
  values(s.id,p_participant_id,p_request_id,q.id,p_expected_answer_revision,true,'reserved','api_generated') returning id into rid;
  insert into public.question_regeneration_attempts(regeneration_request_id,session_id,root_question_id,
    input_snapshot,image_snapshot,exclusion_snapshot)
  values(rid,s.id,q.root_question_id,snap->'input',snap->'images',snap->'exclusions');
  insert into public.question_regeneration_events(regeneration_request_id,session_id,event_type) values(rid,s.id,'reserved');
  return public.question_regeneration_result(rid,true,false);
end;
$$;

-- All continuation RPCs use session -> profile -> question/answer -> request/attempt locking.
create function public.lock_question_regeneration(p_attempt_id uuid,p_request_id uuid,p_participant_id uuid,p_recheck boolean)
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
    if s.status<>'in_progress' or public.question_generation_has_running(s.id) then raise exception 'Session read-only' using errcode='55000'; end if;
    perform 1 from public.questions where id=a.root_question_id and session_id=s.id for update;
    select * into q from public.questions where id=r.question_id and session_id=s.id for update;
    select * into ans from public.answers where question_id=q.id for update;
    if not q.is_active_version or q.root_question_id<>a.root_question_id or q.regeneration_index>=2
      or ans.updated_at is distinct from r.expected_answer_revision then raise exception 'Question or answer changed' using errcode='40001'; end if;
    if q.status='answered' or length(btrim(coalesce(ans.original_answer,'')))>0 or length(btrim(coalesce(ans.refined_answer,'')))>0 then
      raise exception 'Written answers must be preserved' using errcode='55000';
    end if;
    snap:=public.question_regeneration_snapshot(s.id);
    if a.input_snapshot<>snap->'input' or a.image_snapshot<>snap->'images' or a.exclusion_snapshot<>snap->'exclusions' then
      raise exception 'Regeneration snapshot changed' using errcode='40001';
    end if;
  end if;
  perform 1 from public.question_regeneration_requests where id=r.id for update;
  perform 1 from public.question_regeneration_attempts where id=a.id for update;
  return r.id;
end;
$$;

create function public.authorize_question_regeneration_dispatch(p_attempt_id uuid,p_request_id uuid,p_participant_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare rid uuid; a public.question_regeneration_attempts%rowtype; r public.question_regeneration_requests%rowtype;
begin
  rid:=public.lock_question_regeneration(p_attempt_id,p_request_id,p_participant_id,false);
  select * into r from public.question_regeneration_requests where id=rid;
  if r.status<>'reserved' then return false; end if;
  perform public.lock_question_regeneration(p_attempt_id,p_request_id,p_participant_id,true);
  select * into a from public.question_regeneration_attempts where id=p_attempt_id;
  if a.reserved_expires_at<=clock_timestamp() then raise exception 'Reserved lease expired' using errcode='55000'; end if;
  if (select count(*) from public.question_regeneration_attempts where session_id=a.session_id and dispatched_at is not null)>=3 then
    raise exception 'API dispatch limit reached' using errcode='54000';
  end if;
  update public.question_regeneration_attempts set dispatched_at=clock_timestamp(),dispatch_expires_at=clock_timestamp()+interval '90 seconds' where id=a.id;
  update public.question_regeneration_requests set status='dispatch_started' where id=rid;
  insert into public.question_regeneration_events(regeneration_request_id,session_id,event_type) values(rid,a.session_id,'dispatch_started');
  return true;
end;
$$;

create function public.validate_question_regeneration_candidate(p_candidate jsonb,p_input jsonb,p_images jsonb,p_exclusions jsonb)
returns void language plpgsql immutable set search_path='' as $$
declare
  framework constant jsonb := '{
    "사고의 자각과 외재화":["자기인식 질문","사고 외재화 질문","언어화 질문","시각화 질문"],
    "사고의 근거와 구조 검토":["의도 및 판단 근거 질문","가정 탐색 질문","개념 명료화 질문","관계 탐색 질문","결과 예상 질문","사고 점검 질문"],
    "사고의 확장과 재구성":["문제 재구성 질문","사용자 및 맥락 확장 질문","경험 및 사례 연결 질문","제약 재검토 질문","해결방식 재검토 질문","상충 관점 질문","시스템 관점 질문","우선순위 질문"],
    "탐색적 실행과 검증":["대안 생성 질문","시각화 및 구체화 질문","실험 및 프로토타이핑 질문","가치 및 적합성 검토 질문"],
    "자기점검과 조절":["수행 모니터링 질문","자기변화 관찰 질문","예상 및 결과 비교 질문","행동 및 반응 관찰 질문","목표 및 전략 조절 질문"]}';
  text_value text; target jsonb; region jsonb; indices integer[];
  x double precision; y double precision; width double precision; height double precision;
begin
  if p_candidate is null or jsonb_typeof(p_candidate)<>'object' or octet_length(p_candidate::text)>32768
    or not p_candidate ?& array['candidate_rank','question_text','content_principle','question_type','related_contexts','answer_guides','target']
    or (p_candidate-array['candidate_rank','question_text','content_principle','question_type','related_contexts','answer_guides','target'])<>'{}'::jsonb
    or p_candidate->'candidate_rank' is distinct from '1'::jsonb
    or jsonb_typeof(p_candidate->'question_text') is distinct from 'string'
    or jsonb_typeof(p_candidate->'content_principle') is distinct from 'string'
    or jsonb_typeof(p_candidate->'question_type') is distinct from 'string'
    or not coalesce((framework->(p_candidate->>'content_principle')) ? (p_candidate->>'question_type'),false) then
    raise exception 'Invalid single candidate fields, rank or framework hierarchy' using errcode='22023';
  end if;
  text_value:=btrim(p_candidate->>'question_text');
  if length(text_value)=0 or length(text_value)>2000 or exists(select 1 from jsonb_array_elements(p_exclusions) e
    where lower(regexp_replace(normalize(e->>'question_text',NFKC),'[[:space:][:punct:]]','','g'))
      =lower(regexp_replace(normalize(text_value,NFKC),'[[:space:][:punct:]]','','g'))) then
    raise exception 'Duplicate or oversized question' using errcode='22023';
  end if;
  perform public.normalize_question_related_contexts(p_candidate->'related_contexts',p_input->'context_ids');
  if jsonb_typeof(p_candidate->'answer_guides') is distinct from 'array' then
    raise exception 'Invalid answer guides' using errcode='22023';
  end if;
  if jsonb_array_length(p_candidate->'answer_guides')>3 or exists(
    select 1 from jsonb_array_elements(p_candidate->'answer_guides') g
    where jsonb_typeof(g)<>'string' or length(btrim(g #>> '{}'))=0) then
    raise exception 'Invalid answer guides' using errcode='22023';
  end if;
  target:=p_candidate->'target';
  if jsonb_typeof(target) is distinct from 'object' or not target ?& array['type','image_indices','region']
    or (target-array['type','image_indices','region'])<>'{}'::jsonb
    or coalesce(target->>'type','') not in ('region','image','multi_image')
    or jsonb_typeof(target->'image_indices') is distinct from 'array' then
    raise exception 'Invalid target shape' using errcode='22023';
  end if;
  if jsonb_array_length(target->'image_indices') not between 1 and 10 or exists(
    select 1 from jsonb_array_elements(target->'image_indices') i where jsonb_typeof(i)<>'number'
      or i::text !~ '^[1-9][0-9]*$' or (i #>> '{}')::numeric>jsonb_array_length(p_images)) then
    raise exception 'Invalid image index' using errcode='22023';
  end if;
  select array_agg((i #>> '{}')::integer) into indices from jsonb_array_elements(target->'image_indices') i;
  if (select count(distinct i) from unnest(indices) i)<>cardinality(indices)
    or (target->>'type' in ('region','image') and cardinality(indices)<>1)
    or (target->>'type'='multi_image' and cardinality(indices)<2) then
    raise exception 'Invalid target cardinality' using errcode='22023';
  end if;
  region:=target->'region';
  if target->>'type'='region' then
    if jsonb_typeof(region) is distinct from 'object' or not region ?& array['x','y','width','height']
      or (region-array['x','y','width','height'])<>'{}'::jsonb
      or exists(select 1 from jsonb_each(region) r where jsonb_typeof(r.value)<>'number') then
      raise exception 'Invalid region shape' using errcode='22023';
    end if;
    x:=(region->>'x')::double precision; y:=(region->>'y')::double precision;
    width:=(region->>'width')::double precision; height:=(region->>'height')::double precision;
    if x<0 or y<0 or width<=0 or height<=0 or x+width>1 or y+height>1 then
      raise exception 'Invalid region bounds' using errcode='22023';
    end if;
  elsif region is distinct from 'null'::jsonb then
    raise exception 'Whole image targets require null region' using errcode='22023';
  end if;
end;
$$;

create function public.stage_question_regeneration_candidate(p_attempt_id uuid,p_request_id uuid,p_participant_id uuid,
  p_candidate jsonb,p_model_id text,p_prompt_version text,p_schema_version text,p_framework_version text,p_generated_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid; a public.question_regeneration_attempts%rowtype; r public.question_regeneration_requests%rowtype;
  c public.question_regeneration_candidates%rowtype; cid uuid; normalized jsonb;
begin
  rid:=public.lock_question_regeneration(p_attempt_id,p_request_id,p_participant_id,false);
  select * into r from public.question_regeneration_requests where id=rid;
  select * into a from public.question_regeneration_attempts where id=p_attempt_id;
  perform public.validate_question_regeneration_candidate(p_candidate,a.input_snapshot,a.image_snapshot,a.exclusion_snapshot);
  normalized:=p_candidate||jsonb_build_object('related_contexts',
    to_jsonb(public.normalize_question_related_contexts(p_candidate->'related_contexts',a.input_snapshot->'context_ids')));
  select * into c from public.question_regeneration_candidates where attempt_id=p_attempt_id;
  if found then
    if r.status not in ('staged','completed') or c.candidate is distinct from normalized
      or c.model_id is distinct from p_model_id or c.prompt_version is distinct from p_prompt_version
      or c.schema_version is distinct from p_schema_version or c.framework_version is distinct from p_framework_version
      or c.generated_at is distinct from p_generated_at then raise exception 'Candidate identity changed' using errcode='40001'; end if;
    return jsonb_build_object('candidate_id',c.id,'attempt_id',p_attempt_id,'staged',false);
  end if;
  if r.status<>'dispatch_started' then raise exception 'Dispatch required' using errcode='55000'; end if;
  perform public.lock_question_regeneration(p_attempt_id,p_request_id,p_participant_id,true);
  select * into a from public.question_regeneration_attempts where id=p_attempt_id;
  if a.dispatch_expires_at<=clock_timestamp() then raise exception 'Dispatch expired' using errcode='55000'; end if;
  perform public.validate_question_regeneration_candidate(p_candidate,a.input_snapshot,a.image_snapshot,a.exclusion_snapshot);
  insert into public.question_regeneration_candidates(attempt_id,session_id,candidate,model_id,prompt_version,schema_version,framework_version,generated_at)
  values(a.id,a.session_id,normalized,p_model_id,p_prompt_version,p_schema_version,p_framework_version,p_generated_at) returning id into cid;
  update public.question_regeneration_requests set status='staged' where id=rid;
  insert into public.question_regeneration_events(regeneration_request_id,session_id,event_type) values(rid,a.session_id,'staged');
  return jsonb_build_object('candidate_id',cid,'attempt_id',p_attempt_id,'staged',true);
end;
$$;

create function public.commit_question_regeneration(p_attempt_id uuid,p_request_id uuid,p_participant_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid; r public.question_regeneration_requests%rowtype; a public.question_regeneration_attempts%rowtype;
  q public.questions%rowtype; c public.question_regeneration_candidates%rowtype;
  newid uuid:=gen_random_uuid(); idx integer; ord integer:=0; region jsonb;
begin
  rid:=public.lock_question_regeneration(p_attempt_id,p_request_id,p_participant_id,false);
  select * into r from public.question_regeneration_requests where id=rid;
  if r.status='completed' then return public.question_regeneration_result(rid); end if;
  if r.status<>'staged' then raise exception 'Staged candidate required' using errcode='55000'; end if;
  perform public.lock_question_regeneration(p_attempt_id,p_request_id,p_participant_id,true);
  select * into a from public.question_regeneration_attempts where id=p_attempt_id;
  select * into c from public.question_regeneration_candidates where attempt_id=a.id for update;
  if not found or a.dispatched_at is null then raise exception 'Durable dispatch and candidate required' using errcode='55000'; end if;
  perform public.validate_question_regeneration_candidate(c.candidate,a.input_snapshot,a.image_snapshot,a.exclusion_snapshot);
  select * into q from public.questions where id=r.question_id;
  update public.questions set is_active_version=false where id=q.id;
  insert into public.questions(id,session_id,root_question_id,parent_question_id,question_kind,slot_index,
    regeneration_index,question_text,content_principle,detail_type,target_type,selection_reason,
    model_id,prompt_version,framework_version,generated_at,source_regeneration_candidate_id)
  values(newid,r.session_id,a.root_question_id,q.id,'regenerated',q.slot_index,q.regeneration_index+1,
    c.candidate->>'question_text',c.candidate->>'content_principle',c.candidate->>'question_type',
    c.candidate->'target'->>'type','system:api_regeneration;candidate_id='||c.id||';slot_index='||q.slot_index,
    c.model_id,c.prompt_version,c.framework_version,c.generated_at,c.id);
  region:=c.candidate->'target'->'region';
  for idx in select value::integer from jsonb_array_elements_text(c.candidate->'target'->'image_indices') loop
    insert into public.question_targets(question_id,session_id,image_id,x,y,width,height,sort_order)
    values(newid,r.session_id,(a.image_snapshot->(idx-1)->>'id')::uuid,(region->>'x')::double precision,
      (region->>'y')::double precision,(region->>'width')::double precision,(region->>'height')::double precision,ord);
    ord:=ord+1;
  end loop;
  insert into public.question_events(session_id,question_id,participant_id,event_type,event_data)
  values(r.session_id,q.id,p_participant_id,'question_regenerated',jsonb_build_object('request_id',p_request_id,
    'result_question_id',newid,'before_question_id',q.id,'after_question_id',newid,
    'root_question_id',a.root_question_id,'slot_index',q.slot_index,'regeneration_index',q.regeneration_index+1,
    'method','api_generated','attempt_id',a.id,'source_regeneration_candidate_id',c.id,'policy_version',r.policy_version));
  insert into public.question_action_requests(session_id,participant_id,request_id,question_id,action,expected_answer_revision,result_question_id)
  values(r.session_id,p_participant_id,p_request_id,q.id,'regenerate',r.expected_answer_revision,newid);
  update public.question_regeneration_requests set status='completed',result_question_id=newid,finished_at=clock_timestamp() where id=rid;
  insert into public.question_regeneration_events(regeneration_request_id,session_id,event_type) values(rid,r.session_id,'completed');
  return public.question_regeneration_result(rid,false,true);
end;
$$;

create function public.fail_question_regeneration(p_attempt_id uuid,p_request_id uuid,p_participant_id uuid,
  p_error_code text,p_outcome_unknown boolean default false)
returns boolean language plpgsql security definer set search_path='' as $$
declare rid uuid; r public.question_regeneration_requests%rowtype; state text;
begin
  rid:=public.lock_question_regeneration(p_attempt_id,p_request_id,p_participant_id,false);
  select * into r from public.question_regeneration_requests where id=rid;
  if r.status in ('completed','failed','dispatch_unknown') then return false; end if;
  if p_error_code is null or p_error_code not in ('QR-CONFIG','QR-IMAGE','QR-TIMEOUT','QR-REFUSAL','QR-INCOMPLETE',
    'QR-VALIDATION','QR-DUPLICATE','QR-OUTCOME-UNKNOWN','QR-RECOVERY','QR-STALE','QR-API','QR-INPUT-LIMIT')
    or p_outcome_unknown is null or (p_outcome_unknown and r.status<>'dispatch_started') then
    raise exception 'Invalid safe failure outcome' using errcode='22023';
  end if;
  -- A lost authorization acknowledgement is not proof that dispatch was never durably acquired.
  state:=case when r.status='dispatch_started' and (
    p_outcome_unknown or p_error_code in ('QR-RECOVERY','QR-API','QR-TIMEOUT','QR-OUTCOME-UNKNOWN'))
    then 'dispatch_unknown' else 'failed' end;
  update public.question_regeneration_requests set status=state,error_code=p_error_code,finished_at=clock_timestamp() where id=rid;
  insert into public.question_regeneration_events(regeneration_request_id,session_id,event_type,error_code)
    values(rid,r.session_id,state,p_error_code);
  return true;
end;
$$;

create function public.recover_question_regeneration(p_attempt_id uuid,p_request_id uuid,p_participant_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid; r public.question_regeneration_requests%rowtype; a public.question_regeneration_attempts%rowtype;
begin
  rid:=public.lock_question_regeneration(p_attempt_id,p_request_id,p_participant_id,false);
  select * into r from public.question_regeneration_requests where id=rid;
  select * into a from public.question_regeneration_attempts where id=p_attempt_id;
  if r.status='reserved' and a.reserved_expires_at<=clock_timestamp() then
    perform public.fail_question_regeneration(a.id,p_request_id,p_participant_id,'QR-RECOVERY',false);
  elsif r.status='dispatch_started' and a.dispatch_expires_at<=clock_timestamp() then
    perform public.fail_question_regeneration(a.id,p_request_id,p_participant_id,'QR-OUTCOME-UNKNOWN',true);
  end if;
  return public.question_regeneration_result(rid);
end;
$$;

create function public.get_question_regeneration_attempt(p_attempt_id uuid,p_request_id uuid,p_participant_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid; result jsonb;
begin
  rid:=public.lock_question_regeneration(p_attempt_id,p_request_id,p_participant_id,false);
  select public.question_regeneration_result(rid)||jsonb_build_object(
    'id',a.id,'session_id',a.session_id,'root_question_id',a.root_question_id,
    'slot_index',q.slot_index,'regeneration_index',q.regeneration_index,
    'expected_answer_revision',r.expected_answer_revision,'input_snapshot',a.input_snapshot,
    'image_snapshot',a.image_snapshot,'exclusion_snapshot',a.exclusion_snapshot,
    'reserved_expires_at',a.reserved_expires_at,'dispatched_at',a.dispatched_at,'dispatch_expires_at',a.dispatch_expires_at,
    'candidate',case when c.id is null then null else to_jsonb(c) end)
  into result from public.question_regeneration_attempts a join public.question_regeneration_requests r on r.id=rid
    join public.questions q on q.id=r.question_id
    left join public.question_regeneration_candidates c on c.attempt_id=a.id where a.id=p_attempt_id;
  return result;
end;
$$;
create function public.read_question_regeneration(p_session_id uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid; a public.question_action_requests%rowtype;
begin
  if not public.owns_session(p_session_id) then raise exception 'Participant ownership required' using errcode='42501'; end if;
  select id into rid from public.question_regeneration_requests where session_id=p_session_id and request_id=p_request_id;
  if found then return public.question_regeneration_result(rid); end if;
  select * into a from public.question_action_requests where session_id=p_session_id and request_id=p_request_id and action='regenerate';
  if not found then return null; end if;
  return jsonb_build_object('request_id',a.request_id,'question_id',a.question_id,'status','completed','acquired',false,
    'attempt_id',null,'result_question_id',a.result_question_id,'changed',false,'method','reserve','error_code',null);
end;
$$;

create or replace function public.read_question_action_capabilities(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare total integer; slots jsonb; calls integer; pending uuid; pending_question uuid;
begin
  if not public.owns_session(p_session_id) then raise exception 'Participant ownership required' using errcode='42501'; end if;
  select count(*)::integer into total from public.question_candidates c
    join public.question_generation_attempts a on a.id=c.attempt_id
    where c.session_id=p_session_id and a.status='completed' and c.candidate_rank>a.requested_question_count
      and not exists(select 1 from public.questions q where q.source_candidate_id=c.id);
  select coalesce(jsonb_object_agg(q.id::text,(select count(*) from public.question_candidates c
    join public.question_generation_attempts a on a.id=c.attempt_id
    join public.questions root on root.id=q.root_question_id
    join public.question_candidates initial on initial.id=root.source_candidate_id
    where c.attempt_id=initial.attempt_id and a.status='completed' and c.candidate_rank>a.requested_question_count
      and not exists(select 1 from public.questions used where used.source_candidate_id=c.id))),'{}'::jsonb)
  into slots from public.questions q where q.session_id=p_session_id and q.is_active_version
    and q.question_kind in ('original','regenerated');
  select 3-count(*)::integer into calls from public.question_regeneration_attempts
    where session_id=p_session_id and dispatched_at is not null;
  select request_id,question_id into pending,pending_question from public.question_regeneration_requests where session_id=p_session_id
    and status in ('reserved','dispatch_started','staged');
  return jsonb_build_object('ready',true,'reserve_count',total,'reserve_count_by_question',slots,
    'regeneration',jsonb_build_object('ready',true,'calls_remaining',greatest(0,calls),'pending_request_id',pending,
      'pending_question_id',pending_question,
      'per_question',(select coalesce(jsonb_agg(jsonb_build_object('question_id',key,'reserve_count',value)
        order by key),'[]'::jsonb) from jsonb_each(slots))));
end;
$$;
revoke all on function public.read_question_action_capabilities(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_question_action_capabilities(uuid) to authenticated;

do $$
declare name text; fn record;
begin
  foreach name in array array['question_regeneration_requests','question_regeneration_attempts','question_regeneration_candidates','question_regeneration_events'] loop
    execute format('alter table public.%I enable row level security',name);
    execute format('alter table public.%I owner to postgres',name);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);
  end loop;
  for fn in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like '%question_regeneration%' or p.proname='guard_question_regeneration_pending_write') loop
    execute format('alter function %s owner to postgres',fn.signature);
    execute format('revoke all on function %s from public,anon,authenticated,service_role',fn.signature);
    if fn.proname in ('begin_question_regeneration','authorize_question_regeneration_dispatch',
      'stage_question_regeneration_candidate','commit_question_regeneration','fail_question_regeneration',
      'recover_question_regeneration','get_question_regeneration_attempt') then
      execute format('grant execute on function %s to service_role',fn.signature);
    elsif fn.proname='read_question_regeneration' then
      execute format('grant execute on function %s to authenticated',fn.signature);
    end if;
  end loop;
end;
$$;
commit;
