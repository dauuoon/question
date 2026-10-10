-- Local only. Remote approval and catalog verification are required before deployment.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

create table public.question_generation_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete restrict,
  request_id uuid not null,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  input_snapshot jsonb not null check (jsonb_typeof(input_snapshot) = 'object'),
  image_snapshot jsonb not null check (
    jsonb_typeof(image_snapshot) = 'array' and jsonb_array_length(image_snapshot) between 1 and 10
  ),
  requested_question_count integer not null check (requested_question_count between 1 and 5),
  validated_candidates jsonb check (
    jsonb_typeof(validated_candidates) = 'array' and jsonb_array_length(validated_candidates) = 5
  ),
  model_id text,
  prompt_version text,
  schema_version text,
  framework_version text,
  generated_at timestamptz,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  failed_at timestamptz,
  failure_code text check (failure_code in (
    'QGEN-API', 'QGEN-TIMEOUT', 'QGEN-VALIDATION', 'QGEN-COMMIT', 'QGEN-STALE', 'QGEN-CANCELLED'
  )),
  unique (session_id, request_id),
  unique (id, session_id),
  check (
    (status = 'running' and completed_at is null and failed_at is null and failure_code is null)
    or (status = 'completed' and completed_at is not null and failed_at is null and failure_code is null
      and validated_candidates is not null)
    or (status = 'failed' and failed_at is not null and completed_at is null and failure_code is not null)
  ),
  check (
    (validated_candidates is null and model_id is null and prompt_version is null
      and schema_version is null and framework_version is null and generated_at is null)
    or (validated_candidates is not null and length(btrim(model_id)) > 0 and model_id is not null
      and prompt_version = 'question-generation-v2.5' and prompt_version is not null
      and schema_version = 'why_box_question_generation_v2_0' and schema_version is not null
      and framework_version = 'v1.0' and framework_version is not null and generated_at is not null)
  )
);
create unique index question_generation_one_running
  on public.question_generation_attempts(session_id) where status = 'running';

create table public.question_candidates (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete restrict,
  attempt_id uuid not null,
  candidate_rank integer not null check (candidate_rank between 1 and 5),
  question_text text not null check (length(btrim(question_text)) > 0),
  content_principle text not null,
  question_type text not null,
  related_contexts text[] not null,
  context_ids text[] not null,
  answer_guides text[] not null check (cardinality(answer_guides) between 0 and 3),
  target jsonb not null check (
    jsonb_typeof(target) = 'object' and target ?& array['type','image_indices','region']
    and (target - array['type','image_indices','region']) = '{}'::jsonb
    and target->>'type' in ('region','image','multi_image')
    and jsonb_typeof(target->'image_indices') = 'array'
    and jsonb_array_length(target->'image_indices') between 1 and 10
    and (jsonb_typeof(target->'region') = 'object' or target->'region' = 'null'::jsonb)
  ),
  model_id text not null check (length(btrim(model_id)) > 0),
  prompt_version text not null check (prompt_version = 'question-generation-v2.5'),
  schema_version text not null check (schema_version = 'why_box_question_generation_v2_0'),
  framework_version text not null check (framework_version = 'v1.0'),
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (attempt_id, candidate_rank),
  unique (id, session_id),
  foreign key (attempt_id, session_id)
    references public.question_generation_attempts(id, session_id) on delete restrict
);
create index question_candidates_session_rank on public.question_candidates(session_id, candidate_rank);

alter table public.questions add column source_candidate_id uuid;
alter table public.questions add constraint questions_source_candidate_session_fk
  foreign key (source_candidate_id, session_id) references public.question_candidates(id, session_id) on delete restrict;
create unique index questions_original_candidate_unique on public.questions(source_candidate_id)
  where question_kind = 'original' and source_candidate_id is not null;

alter table public.question_generation_attempts enable row level security;
alter table public.question_candidates enable row level security;
revoke all on public.question_generation_attempts, public.question_candidates from public, anon, authenticated, service_role;
grant select on public.question_generation_attempts, public.question_candidates to authenticated, service_role;
create policy question_generation_attempts_select_owner_or_admin on public.question_generation_attempts
  for select to authenticated using (public.owns_session(session_id) or public.is_active_admin());
create policy question_candidates_select_owner_or_admin on public.question_candidates
  for select to authenticated using (public.owns_session(session_id) or public.is_active_admin());

create function public.question_generation_snapshot(p_session_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'input', jsonb_build_object(
      'primary_category_id', s.primary_category_id, 'subcategory_id', s.subcategory_id,
      'other_category_text', s.other_category_text, 'stage_id', s.stage_id,
      'additional_context', s.additional_context,
      'context_ids', coalesce((select jsonb_agg(sc.context_id order by sc.context_id)
        from public.session_contexts sc where sc.session_id = s.id), '[]'::jsonb)
    ),
    'images', coalesce((select jsonb_agg(jsonb_build_object(
      'id', i.id, 'sort_order', i.sort_order, 'storage_path', i.storage_path,
      'mime_type', i.mime_type, 'file_size', i.file_size, 'width', i.width, 'height', i.height
    ) order by i.sort_order, i.id) from public.session_images i where i.session_id = s.id), '[]'::jsonb),
    'requested_question_count', s.requested_question_count
  ) from public.sessions s where s.id = p_session_id;
$$;

create function public.question_generation_has_running(p_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.question_generation_attempts a
    where a.session_id = p_session_id and a.status = 'running');
$$;

create or replace function public.can_edit_session_context(target_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sessions s
    where s.id = target_session_id and s.participant_id = auth.uid()
      and exists (select 1 from public.profiles p where p.id = s.participant_id
        and p.status = 'active' and p.role = 'participant')
      and s.status in ('draft', 'question_generation')
      and not exists (select 1 from public.questions q where q.session_id = s.id)
      and not public.question_generation_has_running(s.id)
  );
$$;

create or replace function public.can_edit_session(target_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sessions s join public.profiles p on p.id=s.participant_id
    where s.id=target_session_id and s.participant_id=auth.uid()
      and p.role='participant' and p.status='active' and s.status<>'completed'
      and not public.question_generation_has_running(s.id)
  );
$$;
-- Also reject unchanged autosaves/manual Context Draft claims at their FOR UPDATE lookup.
create policy sessions_question_generation_locked_update on public.sessions as restrictive
  for update to authenticated using (public.can_edit_session(id)) with check (public.can_edit_session(id));

create function public.guard_question_generation_input()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_old_id uuid;
begin
  if tg_table_name = 'sessions' then
    if public.question_generation_has_running(old.id) and (
      new.primary_category_id is distinct from old.primary_category_id
      or new.subcategory_id is distinct from old.subcategory_id
      or new.other_category_text is distinct from old.other_category_text
      or new.stage_id is distinct from old.stage_id
      or new.additional_context is distinct from old.additional_context
      or new.requested_question_count is distinct from old.requested_question_count
      or (new.status is distinct from old.status and coalesce(auth.role(), '') <> 'service_role')
    ) then
      raise exception 'Question generation input is locked' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_table_name = 'objects' then
    if tg_op <> 'INSERT' then
      select u.session_id into v_old_id from public.storage_upload_slots u
        where old.bucket_id = 'why-box-images' and u.storage_path = old.name;
    end if;
    if tg_op <> 'DELETE' then
      select u.session_id into v_id from public.storage_upload_slots u
        where new.bucket_id = 'why-box-images' and u.storage_path = new.name;
    end if;
  else
    if tg_op <> 'INSERT' then v_old_id := old.session_id; end if;
    if tg_op <> 'DELETE' then v_id := new.session_id; end if;
  end if;
  -- Use the same parent-row lock as begin/commit, including in-flight uploads.
  perform 1 from public.sessions s where s.id in (v_id, v_old_id) order by s.id for update;
  if public.question_generation_has_running(v_id) or public.question_generation_has_running(v_old_id) then
    raise exception 'Question generation input is locked' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger a_question_generation_input_guard before update on public.sessions
  for each row execute function public.guard_question_generation_input();
create trigger a_question_generation_input_guard before insert or update or delete on public.session_contexts
  for each row execute function public.guard_question_generation_input();
create trigger a_question_generation_input_guard before insert or update or delete on public.session_images
  for each row execute function public.guard_question_generation_input();
create trigger a_question_generation_input_guard before insert or update or delete on public.storage_upload_slots
  for each row execute function public.guard_question_generation_input();
create trigger a_question_generation_input_guard before insert or update or delete on storage.objects
  for each row execute function public.guard_question_generation_input();

do $$
begin
  if to_regclass('public.image_deletions') is not null then
    execute 'create trigger a_question_generation_input_guard before insert or update or delete
      on public.image_deletions for each row execute function public.guard_question_generation_input()';
  end if;
end;
$$;

create function public.guard_question_generation_history()
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
    if tg_op = 'INSERT' and new.source_candidate_id is not null and (
      new.question_kind <> 'original' or not exists (
        select 1 from public.question_candidates c join public.question_generation_attempts a on a.id = c.attempt_id
        where c.id = new.source_candidate_id and c.session_id = new.session_id and c.candidate_rank = new.slot_index
          and c.candidate_rank <= a.requested_question_count and a.status = 'running'
          and c.question_text = new.question_text and c.content_principle = new.content_principle
          and c.question_type = new.detail_type and c.target->>'type' = new.target_type
          and c.model_id = new.model_id and c.prompt_version = new.prompt_version
          and c.framework_version = new.framework_version and c.generated_at = new.generated_at
          and new.selection_reason = 'system:initial_top_n;candidate_rank=' || c.candidate_rank ||
            ';requested_question_count=' || a.requested_question_count
      )
    ) then raise exception 'Invalid original candidate provenance' using errcode = '22023'; end if;
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
create trigger question_candidates_history_guard before insert or update or delete on public.question_candidates
  for each row execute function public.guard_question_generation_history();
create trigger question_generation_attempts_history_guard before update or delete on public.question_generation_attempts
  for each row execute function public.guard_question_generation_history();
create trigger questions_candidate_provenance_guard before insert or update on public.questions
  for each row execute function public.guard_question_generation_history();

create function public.begin_question_generation(p_session_id uuid, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.sessions%rowtype;
  v_attempt public.question_generation_attempts%rowtype;
  v_snapshot jsonb;
  v_input jsonb;
  v_contexts text[];
  v_pending_deletion boolean;
  v_categories constant jsonb := '{
    "ux_ui":["web_design","mobile_app_design","digital_product_design","service_design","interaction_design","design_system","game_ui_ux_design"],
    "brand_graphic":["brand_design","graphic_design","poster_design","advertising_campaign_design","content_design","information_design"],
    "editorial_package":["editorial_print_design","package_design"],
    "illustration_character":["illustration","character_design","pattern_design","icon_pictogram_design"],
    "video_motion":["video_thumbnail_design","video_graphic_design","motion_graphic_design"],
    "product_spatial":["industrial_product_design","spatial_design","exhibition_design","signage_environmental_graphic_design"],
    "others":["other"]}';
begin
  if auth.uid() is null or p_session_id is null or p_request_id is null then
    raise exception 'Participant and request required' using errcode = '42501';
  end if;
  select * into v_session from public.sessions s
    where s.id = p_session_id and s.participant_id = auth.uid() for update;
  if not found then raise exception 'Session access denied' using errcode = '42501'; end if;
  perform 1 from public.profiles p where p.id = auth.uid() and p.role = 'participant' and p.status = 'active' for share;
  if not found then raise exception 'Active Participant required' using errcode = '42501'; end if;
  select * into v_attempt from public.question_generation_attempts a
    where a.session_id = p_session_id and a.request_id = p_request_id;
  if found then return jsonb_build_object('attempt_id',v_attempt.id,'status',v_attempt.status,'acquired',false); end if;
  select * into v_attempt from public.question_generation_attempts a
    where a.session_id = p_session_id and a.status in ('running','completed')
    order by a.started_at desc limit 1;
  if found then return jsonb_build_object('attempt_id',v_attempt.id,'status',v_attempt.status,'acquired',false); end if;
  if v_session.status not in ('draft','question_generation')
    or exists (select 1 from public.questions q where q.session_id = p_session_id) then
    raise exception 'Initial generation is not available' using errcode = '42501';
  end if;
  if exists (select 1 from public.storage_upload_slots u where u.session_id = p_session_id
    and not exists (select 1 from public.session_images i where i.session_id = u.session_id and i.storage_path = u.storage_path)) then
    raise exception 'Unresolved image upload reservation' using errcode = '55000';
  end if;
  if to_regclass('public.image_deletions') is not null then
    execute 'select exists(select 1 from public.image_deletions where session_id=$1 and completed_at is null)'
      into v_pending_deletion using p_session_id;
    if v_pending_deletion then raise exception 'Pending image deletion' using errcode = '55000'; end if;
  end if;
  v_snapshot := public.question_generation_snapshot(p_session_id);
  v_input := v_snapshot->'input';
  select coalesce(array_agg(c),array[]::text[]) into v_contexts from jsonb_array_elements_text(v_input->'context_ids') c;
  if not coalesce((v_categories->(v_input->>'primary_category_id')) ? (v_input->>'subcategory_id'),false)
    or ((v_input->>'primary_category_id') = 'others' and length(btrim(coalesce(v_input->>'other_category_text',''))) = 0)
    or ((v_input->>'primary_category_id') <> 'others' and nullif(v_input->>'other_category_text','') is not null)
    or coalesce(v_input->>'stage_id','') <> all(array[
      'research_problem_definition','idea_concept','structure_design','visualization_specification','review_improvement'])
    or char_length(coalesce(v_input->>'additional_context','')) > 1000
    or cardinality(v_contexts) not between 1 and 3
    or exists(select 1 from unnest(v_contexts) c where c <> all(array[
      'problem_and_goal','design_concept','user_perspective','information_element_structure','visual_form',
      'other_perspectives','decision_reasoning','intent_alignment','next_steps']))
    or jsonb_array_length(v_snapshot->'images') not between 1 and 10
    or exists(select 1 from jsonb_array_elements(v_snapshot->'images') i
      where not starts_with(i->>'storage_path', v_session.participant_id::text || '/' || p_session_id::text || '/')
        or not exists(select 1 from storage.objects o where o.bucket_id='why-box-images' and o.name=i->>'storage_path')) then
    raise exception 'Invalid saved generation input' using errcode = '22023';
  end if;
  insert into public.question_generation_attempts(session_id,request_id,input_snapshot,image_snapshot,requested_question_count)
    values(p_session_id,p_request_id,v_input,v_snapshot->'images',v_session.requested_question_count) returning * into v_attempt;
  return jsonb_build_object('attempt_id',v_attempt.id,'status',v_attempt.status,'acquired',true);
end;
$$;

create function public.normalize_question_related_contexts(p_values jsonb, p_selected jsonb)
returns text[] language plpgsql immutable set search_path = '' as $$
declare
  v_labels constant jsonb := '{
    "problem_and_goal":"문제와 목표를 다시 살펴보고 싶어요",
    "design_concept":"현재 디자인의 컨셉을 점검하고 싶어요",
    "user_perspective":"사용자의 관점에서 생각해보고 싶어요",
    "information_element_structure":"정보와 요소의 구조를 점검하고 싶어요",
    "visual_form":"시각적·형태적 표현을 살펴보고 싶어요",
    "other_perspectives":"다른 관점이나 가능성을 탐색하고 싶어요",
    "decision_reasoning":"내 판단의 이유와 근거를 점검하고 싶어요",
    "intent_alignment":"현재 결과가 의도에 맞는지 확인하고 싶어요",
    "next_steps":"다음 단계에서 무엇을 시도할지 생각해보고 싶어요"}';
  v_value jsonb;
  v_id text;
  v_result text[] := array[]::text[];
begin
  if jsonb_typeof(p_values) is distinct from 'array' then raise exception 'Invalid related contexts' using errcode = '22023'; end if;
  for v_value in select value from jsonb_array_elements(p_values) loop
    if jsonb_typeof(v_value) <> 'string' then raise exception 'Invalid related context type' using errcode = '22023'; end if;
    select key into v_id from jsonb_each_text(v_labels)
      where key = v_value #>> '{}' or value = v_value #>> '{}';
    if v_id is null or not p_selected ? v_id or v_id = any(v_result) then
      raise exception 'Related contexts must be distinct selected contexts' using errcode = '22023';
    end if;
    v_result := array_append(v_result,v_id);
  end loop;
  return v_result;
end;
$$;

create function public.validate_question_candidates(p_candidates jsonb, p_input jsonb, p_images jsonb, p_count integer)
returns void language plpgsql immutable set search_path = '' as $$
declare
  v_framework constant jsonb := '{
    "사고의 자각과 외재화":["자기인식 질문","사고 외재화 질문","언어화 질문","시각화 질문"],
    "사고의 근거와 구조 검토":["의도 및 판단 근거 질문","가정 탐색 질문","개념 명료화 질문","관계 탐색 질문","결과 예상 질문","사고 점검 질문"],
    "사고의 확장과 재구성":["문제 재구성 질문","사용자 및 맥락 확장 질문","경험 및 사례 연결 질문","제약 재검토 질문","해결방식 재검토 질문","상충 관점 질문","시스템 관점 질문","우선순위 질문"],
    "탐색적 실행과 검증":["대안 생성 질문","시각화 및 구체화 질문","실험 및 프로토타이핑 질문","가치 및 적합성 검토 질문"],
    "자기점검과 조절":["수행 모니터링 질문","자기변화 관찰 질문","예상 및 결과 비교 질문","행동 및 반응 관찰 질문","목표 및 전략 조절 질문"]}';
  v_candidate jsonb;
  v_target jsonb;
  v_region jsonb;
  v_rank integer := 0;
  v_indices integer[];
  v_contexts text[];
  v_top_related boolean := false;
  v_texts text[] := array[]::text[];
  v_text text;
  v_x double precision; v_y double precision; v_width double precision; v_height double precision;
begin
  if p_candidates is null or jsonb_typeof(p_candidates) <> 'array' then
    raise exception 'Candidates must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_candidates) <> 5 or octet_length(p_candidates::text) > 262144 or p_count not between 1 and 5 then
    raise exception 'Exactly five bounded candidates required' using errcode = '22023';
  end if;
  for v_candidate in select value from jsonb_array_elements(p_candidates) loop
    v_rank := v_rank + 1;
    if jsonb_typeof(v_candidate) <> 'object'
      or not v_candidate ?& array['candidate_rank','question_text','content_principle','question_type','related_contexts','answer_guides','target']
      or (v_candidate - array['candidate_rank','question_text','content_principle','question_type','related_contexts','answer_guides','target']) <> '{}'::jsonb
      or v_candidate->'candidate_rank' is distinct from to_jsonb(v_rank)
      or jsonb_typeof(v_candidate->'question_text') <> 'string'
      or jsonb_typeof(v_candidate->'content_principle') <> 'string'
      or jsonb_typeof(v_candidate->'question_type') <> 'string'
      or not coalesce((v_framework->(v_candidate->>'content_principle')) ? (v_candidate->>'question_type'),false) then
      raise exception 'Invalid candidate fields, rank or framework hierarchy' using errcode = '22023';
    end if;
    v_text := btrim(v_candidate->>'question_text');
    if length(v_text) = 0 or v_text = any(v_texts) then raise exception 'Empty or duplicate question' using errcode = '22023'; end if;
    v_texts := array_append(v_texts,v_text);
    v_contexts := public.normalize_question_related_contexts(v_candidate->'related_contexts',p_input->'context_ids');
    if v_rank <= p_count and cardinality(v_contexts) > 0 then v_top_related := true; end if;
    if jsonb_typeof(v_candidate->'answer_guides') <> 'array' then
      raise exception 'Invalid answer guides' using errcode = '22023';
    end if;
    if jsonb_array_length(v_candidate->'answer_guides') > 3 or exists(
      select 1 from jsonb_array_elements(v_candidate->'answer_guides') g
      where jsonb_typeof(g) <> 'string' or length(btrim(g #>> '{}')) = 0
    ) then raise exception 'Invalid answer guides' using errcode = '22023'; end if;
    v_target := v_candidate->'target';
    if jsonb_typeof(v_target) <> 'object' or not v_target ?& array['type','image_indices','region']
      or (v_target - array['type','image_indices','region']) <> '{}'::jsonb
      or jsonb_typeof(v_target->'type') <> 'string'
      or coalesce(v_target->>'type','') not in ('region','image','multi_image')
      or jsonb_typeof(v_target->'image_indices') <> 'array' then
      raise exception 'Invalid target shape' using errcode = '22023';
    end if;
    if jsonb_array_length(v_target->'image_indices') not between 1 and 10 or exists(
      select 1 from jsonb_array_elements(v_target->'image_indices') i
      where jsonb_typeof(i) <> 'number' or i::text !~ '^[1-9][0-9]*$'
        or (i #>> '{}')::numeric > jsonb_array_length(p_images)
    ) then raise exception 'Invalid image index' using errcode = '22023'; end if;
    select array_agg((i #>> '{}')::integer) into v_indices from jsonb_array_elements(v_target->'image_indices') i;
    if (select count(distinct i) from unnest(v_indices) i) <> cardinality(v_indices)
      or (v_target->>'type' in ('region','image') and cardinality(v_indices) <> 1)
      or (v_target->>'type' = 'multi_image' and cardinality(v_indices) < 2) then
      raise exception 'Invalid target cardinality' using errcode = '22023';
    end if;
    v_region := v_target->'region';
    if v_target->>'type' = 'region' then
      if jsonb_typeof(v_region) <> 'object' or not v_region ?& array['x','y','width','height']
        or (v_region - array['x','y','width','height']) <> '{}'::jsonb
        or exists(select 1 from jsonb_each(v_region) r where jsonb_typeof(r.value) <> 'number') then
        raise exception 'Invalid region shape' using errcode = '22023';
      end if;
      v_x := (v_region->>'x')::double precision; v_y := (v_region->>'y')::double precision;
      v_width := (v_region->>'width')::double precision; v_height := (v_region->>'height')::double precision;
      if v_x < 0 or v_y < 0 or v_width <= 0 or v_height <= 0 or v_x + v_width > 1 or v_y + v_height > 1 then
        raise exception 'Invalid region bounds' using errcode = '22023';
      end if;
    elsif v_region is distinct from 'null'::jsonb then
      raise exception 'Whole image targets require null region' using errcode = '22023';
    end if;
  end loop;
  if not v_top_related then raise exception 'Top N must reflect a selected context' using errcode = '22023'; end if;
end;
$$;

create function public.stage_question_generation_candidates(
  p_attempt_id uuid, p_request_id uuid, p_candidates jsonb, p_model_id text,
  p_prompt_version text, p_schema_version text, p_framework_version text, p_generated_at timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_attempt public.question_generation_attempts%rowtype;
  v_session public.sessions%rowtype;
  v_snapshot jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Trusted server required' using errcode = '42501'; end if;
  select s.* into v_session from public.sessions s join public.question_generation_attempts a on a.session_id=s.id
    where a.id=p_attempt_id and a.request_id=p_request_id for update of s;
  if not found then raise exception 'Attempt not found' using errcode = '22023'; end if;
  select * into v_attempt from public.question_generation_attempts a where a.id=p_attempt_id for update;
  if v_attempt.status = 'completed' then return false; end if;
  if v_attempt.status <> 'running' or v_session.status not in ('draft','question_generation') then
    raise exception 'Attempt is not running' using errcode = '55000';
  end if;
  perform 1 from public.profiles p where p.id=v_session.participant_id and p.status='active' and p.role='participant' for share;
  if not found then raise exception 'Active Participant required' using errcode = '42501'; end if;
  v_snapshot := public.question_generation_snapshot(v_session.id);
  if v_attempt.input_snapshot <> v_snapshot->'input' or v_attempt.image_snapshot <> v_snapshot->'images'
    or v_attempt.requested_question_count <> (v_snapshot->>'requested_question_count')::integer then
    raise exception 'Generation snapshot changed' using errcode = '40001';
  end if;
  perform public.validate_question_candidates(p_candidates,v_attempt.input_snapshot,v_attempt.image_snapshot,v_attempt.requested_question_count);
  if p_model_id is null or length(btrim(p_model_id))=0 or p_prompt_version is distinct from 'question-generation-v2.5'
    or p_schema_version is distinct from 'why_box_question_generation_v2_0' or p_framework_version is distinct from 'v1.0'
    or p_generated_at is null then raise exception 'Invalid generation metadata' using errcode = '22023'; end if;
  if v_attempt.validated_candidates is not null then
    if v_attempt.validated_candidates <> p_candidates or v_attempt.model_id <> p_model_id
      or v_attempt.prompt_version <> p_prompt_version or v_attempt.schema_version <> p_schema_version
      or v_attempt.framework_version <> p_framework_version or v_attempt.generated_at <> p_generated_at then
      raise exception 'Staged candidates are immutable' using errcode = '22023';
    end if;
    return false;
  end if;
  update public.question_generation_attempts set validated_candidates=p_candidates, model_id=p_model_id,
    prompt_version=p_prompt_version,schema_version=p_schema_version,framework_version=p_framework_version,generated_at=p_generated_at
    where id=p_attempt_id;
  return true;
end;
$$;

create function public.commit_question_generation(p_attempt_id uuid, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_attempt public.question_generation_attempts%rowtype;
  v_session public.sessions%rowtype;
  v_snapshot jsonb;
  v_candidate jsonb;
  v_candidate_id uuid;
  v_question_id uuid;
  v_rank integer;
  v_image_index integer;
  v_target_order integer;
  v_region jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Trusted server required' using errcode = '42501'; end if;
  select s.* into v_session from public.sessions s join public.question_generation_attempts a on a.session_id=s.id
    where a.id=p_attempt_id and a.request_id=p_request_id for update of s;
  if not found then raise exception 'Attempt not found' using errcode = '22023'; end if;
  select * into v_attempt from public.question_generation_attempts a where a.id=p_attempt_id for update;
  if v_attempt.status = 'completed' then
    return jsonb_build_object('attempt_id',v_attempt.id,'session_id',v_attempt.session_id,'status','completed','saved',false);
  end if;
  if v_attempt.status <> 'running' or v_attempt.validated_candidates is null
    or v_session.status not in ('draft','question_generation')
    or exists(select 1 from public.questions q where q.session_id=v_session.id) then
    raise exception 'Attempt cannot commit' using errcode = '55000';
  end if;
  perform 1 from public.profiles p where p.id=v_session.participant_id and p.status='active' and p.role='participant' for share;
  if not found then raise exception 'Active Participant required' using errcode = '42501'; end if;
  v_snapshot := public.question_generation_snapshot(v_session.id);
  if v_attempt.input_snapshot <> v_snapshot->'input' or v_attempt.image_snapshot <> v_snapshot->'images'
    or v_attempt.requested_question_count <> (v_snapshot->>'requested_question_count')::integer then
    raise exception 'Generation snapshot changed' using errcode = '40001';
  end if;
  perform public.validate_question_candidates(v_attempt.validated_candidates,v_attempt.input_snapshot,v_attempt.image_snapshot,v_attempt.requested_question_count);
  if v_session.status='draft' then update public.sessions set status='question_generation' where id=v_session.id; end if;
  for v_candidate in select value from jsonb_array_elements(v_attempt.validated_candidates) loop
    v_rank := (v_candidate->>'candidate_rank')::integer;
    insert into public.question_candidates(session_id,attempt_id,candidate_rank,question_text,content_principle,question_type,
      related_contexts,context_ids,answer_guides,target,model_id,prompt_version,schema_version,framework_version,generated_at)
    values(v_session.id,v_attempt.id,v_rank,v_candidate->>'question_text',v_candidate->>'content_principle',v_candidate->>'question_type',
      array(select jsonb_array_elements_text(v_candidate->'related_contexts')),
      public.normalize_question_related_contexts(v_candidate->'related_contexts',v_attempt.input_snapshot->'context_ids'),
      array(select jsonb_array_elements_text(v_candidate->'answer_guides')),v_candidate->'target',
      v_attempt.model_id,v_attempt.prompt_version,v_attempt.schema_version,v_attempt.framework_version,v_attempt.generated_at)
    returning id into v_candidate_id;
    if v_rank <= v_attempt.requested_question_count then
      v_question_id := gen_random_uuid();
      insert into public.questions(id,session_id,root_question_id,question_kind,slot_index,regeneration_index,
        question_text,content_principle,detail_type,target_type,selection_reason,model_id,prompt_version,framework_version,
        generated_at,source_candidate_id)
      values(v_question_id,v_session.id,v_question_id,'original',v_rank,0,v_candidate->>'question_text',
        v_candidate->>'content_principle',v_candidate->>'question_type',v_candidate->'target'->>'type',
        'system:initial_top_n;candidate_rank=' || v_rank || ';requested_question_count=' || v_attempt.requested_question_count,
        v_attempt.model_id,v_attempt.prompt_version,v_attempt.framework_version,v_attempt.generated_at,v_candidate_id);
      v_target_order := 0;
      v_region := v_candidate->'target'->'region';
      for v_image_index in select value::integer from jsonb_array_elements_text(v_candidate->'target'->'image_indices') loop
        insert into public.question_targets(question_id,session_id,image_id,x,y,width,height,sort_order)
        values(v_question_id,v_session.id,(v_attempt.image_snapshot->(v_image_index-1)->>'id')::uuid,
          (v_region->>'x')::double precision,(v_region->>'y')::double precision,
          (v_region->>'width')::double precision,(v_region->>'height')::double precision,v_target_order);
        v_target_order := v_target_order + 1;
      end loop;
    end if;
  end loop;
  update public.sessions set status='in_progress',model_id=v_attempt.model_id,
    prompt_version=v_attempt.prompt_version,framework_version=v_attempt.framework_version where id=v_session.id;
  update public.question_generation_attempts set status='completed',completed_at=clock_timestamp() where id=v_attempt.id;
  return jsonb_build_object('attempt_id',v_attempt.id,'session_id',v_session.id,'status','completed','saved',true);
end;
$$;

create function public.fail_question_generation(p_attempt_id uuid, p_request_id uuid, p_failure_code text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_attempt public.question_generation_attempts%rowtype;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Trusted server required' using errcode = '42501'; end if;
  perform 1 from public.sessions s join public.question_generation_attempts a on a.session_id=s.id
    where a.id=p_attempt_id and a.request_id=p_request_id for update of s;
  if not found then raise exception 'Attempt not found' using errcode = '22023'; end if;
  select * into v_attempt from public.question_generation_attempts a where a.id=p_attempt_id for update;
  if p_failure_code is null or p_failure_code <> all(array[
    'QGEN-API','QGEN-TIMEOUT','QGEN-VALIDATION','QGEN-COMMIT','QGEN-STALE','QGEN-CANCELLED'
  ]) then raise exception 'Invalid safe failure code' using errcode = '22023'; end if;
  if v_attempt.status <> 'running' then return false; end if;
  update public.question_generation_attempts set status='failed',failed_at=clock_timestamp(),failure_code=p_failure_code
    where id=p_attempt_id;
  return true;
end;
$$;

alter table public.question_generation_attempts owner to postgres;
alter table public.question_candidates owner to postgres;
alter function public.question_generation_snapshot(uuid) owner to postgres;
alter function public.question_generation_has_running(uuid) owner to postgres;
alter function public.guard_question_generation_input() owner to postgres;
alter function public.guard_question_generation_history() owner to postgres;
alter function public.normalize_question_related_contexts(jsonb,jsonb) owner to postgres;
alter function public.validate_question_candidates(jsonb,jsonb,jsonb,integer) owner to postgres;
alter function public.begin_question_generation(uuid,uuid) owner to postgres;
alter function public.stage_question_generation_candidates(uuid,uuid,jsonb,text,text,text,text,timestamptz) owner to postgres;
alter function public.commit_question_generation(uuid,uuid) owner to postgres;
alter function public.fail_question_generation(uuid,uuid,text) owner to postgres;

-- Helper/trigger functions cannot be called directly from browser or service clients.
revoke all on function public.question_generation_snapshot(uuid), public.question_generation_has_running(uuid),
  public.guard_question_generation_input(), public.guard_question_generation_history(),
  public.normalize_question_related_contexts(jsonb,jsonb), public.validate_question_candidates(jsonb,jsonb,jsonb,integer),
  public.begin_question_generation(uuid,uuid),
  public.stage_question_generation_candidates(uuid,uuid,jsonb,text,text,text,text,timestamptz),
  public.commit_question_generation(uuid,uuid), public.fail_question_generation(uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_question_generation(uuid,uuid) to authenticated;
grant execute on function public.stage_question_generation_candidates(uuid,uuid,jsonb,text,text,text,text,timestamptz),
  public.commit_question_generation(uuid,uuid), public.fail_question_generation(uuid,uuid,text) to service_role;

notify pgrst, 'reload schema';
commit;
