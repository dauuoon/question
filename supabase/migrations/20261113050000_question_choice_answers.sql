begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create or replace function public.valid_question_answer_form(value jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare n integer;
begin
  if value is null or value='null'::jsonb then return true; end if;
  if jsonb_typeof(value)<>'object'
    or not value ?& array['kind','title','labels']
    or coalesce(value->>'kind','') not in ('numbered','sections','choice')
    or jsonb_typeof(value->'title') is distinct from 'string'
    or length(btrim(value->>'title')) not between 1 and 100
    or jsonb_typeof(value->'labels') is distinct from 'array' then return false; end if;
  n:=jsonb_array_length(value->'labels');
  if n not between 2 and 6
    or exists(select 1 from jsonb_array_elements(value->'labels') l
      where jsonb_typeof(l)<>'string' or length(btrim(l #>> '{}')) not between 1 and 100)
    or (select count(distinct btrim(l #>> '{}')) from jsonb_array_elements(value->'labels') l)<>n
    then return false; end if;
  if value->>'kind'='choice' then
    if not value ?& array['max_selections','explanation_prompt']
      or (value-array['kind','title','labels','max_selections','explanation_prompt'])<>'{}'::jsonb
      or n<4 or value->'labels'->>(n-2)<>'직접 입력' or value->'labels'->>(n-1)<>'짧은 설명'
      or jsonb_typeof(value->'explanation_prompt') is distinct from 'string'
      or length(btrim(value->>'explanation_prompt')) not between 1 and 100
      or jsonb_typeof(value->'max_selections') is distinct from 'number'
      or (value->>'max_selections') !~ '^[1-5]$'
      or (value->>'max_selections')::integer>n-1 then return false; end if;
  elsif (value-array['kind','title','labels'])<>'{}'::jsonb then
    return false;
  end if;
  return true;
end $$;

create or replace function public.guard_answer_fields()
returns trigger language plpgsql security definer set search_path='' as $$
declare form jsonb; rendered text; session_status text; n integer; selected_count integer;
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
  if form->>'kind'='choice' then
    n:=cardinality(new.original_answer_fields);
    if exists(select 1 from generate_series(1,n-2) i
      where new.original_answer_fields[i]<>'' and new.original_answer_fields[i]<>form->'labels'->>(i-1)) then
      raise exception 'Invalid selected option' using errcode='22023';
    end if;
    select count(*) into selected_count from generate_series(1,n-2) i where new.original_answer_fields[i]<>'';
    if new.original_answer_fields[n-1] !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]*$'
      then selected_count:=selected_count+1; end if;
    if selected_count>(form->>'max_selections')::integer then
      raise exception 'Too many selected options' using errcode='22023';
    end if;
  end if;
  select coalesce(string_agg(v,E'\n\n' order by position),'') into rendered
    from unnest(new.original_answer_fields) with ordinality item(v,position)
    where v !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]*$';
  if rendered<>new.original_answer or length(rendered)>20000 then
    raise exception 'Answer text must contain only user field values' using errcode='22023';
  end if;
  return new;
end $$;

alter table public.question_generation_attempts drop constraint question_generation_attempts_prompt_metadata_check;
alter table public.question_generation_attempts add constraint question_generation_attempts_prompt_metadata_check check(
  (validated_candidates is null and model_id is null and prompt_version is null and schema_version is null
    and framework_version is null and generated_at is null)
  or (validated_candidates is not null and model_id is not null and length(btrim(model_id))>0
    and ((prompt_version in ('question-generation-v2.5','question-generation-v2.6','question-generation-v2.7')
      and schema_version='why_box_question_generation_v2_0')
      or (prompt_version in ('question-generation-v2.8','question-generation-v2.9','question-generation-v2.10',
        'question-generation-v2.11','question-generation-v2.12') and schema_version='why_box_question_generation_v2_1')
      or (prompt_version='question-generation-v2.13' and schema_version='why_box_question_generation_v2_2'))
    and prompt_version is not null and schema_version is not null
    and framework_version='v1.0' and framework_version is not null and generated_at is not null));
alter table public.question_candidates drop constraint question_candidates_prompt_version_check;
alter table public.question_candidates add constraint question_candidates_prompt_version_check check(
  prompt_version in ('question-generation-v2.5','question-generation-v2.6','question-generation-v2.7',
    'question-generation-v2.8','question-generation-v2.9','question-generation-v2.10',
    'question-generation-v2.11','question-generation-v2.12','question-generation-v2.13'));
alter table public.question_candidates drop constraint question_candidates_schema_version_check;
alter table public.question_candidates add constraint question_candidates_schema_version_check check(
  (prompt_version in ('question-generation-v2.5','question-generation-v2.6','question-generation-v2.7')
    and schema_version='why_box_question_generation_v2_0')
  or (prompt_version in ('question-generation-v2.8','question-generation-v2.9','question-generation-v2.10',
    'question-generation-v2.11','question-generation-v2.12') and schema_version='why_box_question_generation_v2_1')
  or (prompt_version='question-generation-v2.13' and schema_version='why_box_question_generation_v2_2'));
alter table public.question_regeneration_dispatch_metadata drop constraint question_regeneration_dispatch_metadata_prompt_version_check;
alter table public.question_regeneration_dispatch_metadata add constraint question_regeneration_dispatch_metadata_prompt_version_check check(
  (prompt_version in ('question-regeneration-v1.0','question-regeneration-v1.1','question-regeneration-v1.2')
    and schema_version='why_box_question_regeneration_v1_0')
  or (prompt_version in ('question-regeneration-v1.3','question-regeneration-v1.4','question-regeneration-v1.5',
    'question-regeneration-v1.6','question-regeneration-v1.7') and schema_version='why_box_question_regeneration_v1_1')
  or (prompt_version='question-regeneration-v1.8' and schema_version='why_box_question_regeneration_v1_2'));

do $$
declare f record; definition text; revised text;
begin
  for f in select signature,old_expression,new_expression from (values
    ('public.stage_question_generation_candidates(uuid,uuid,jsonb,text,text,text,text,timestamp with time zone)',
      'and p_schema_version=''why_box_question_generation_v2_1''),false)',
      'and p_schema_version=''why_box_question_generation_v2_1'') or (p_prompt_version=''question-generation-v2.13'' and p_schema_version=''why_box_question_generation_v2_2''),false)'),
    ('public.stage_question_generation_candidates(uuid,uuid,jsonb,text,text,text,text,timestamp with time zone)',
      'or (p_prompt_version in (''question-generation-v2.8'',''question-generation-v2.9'',''question-generation-v2.10'',''question-generation-v2.11'',''question-generation-v2.12'') and exists(',
      'or (p_prompt_version in (''question-generation-v2.8'',''question-generation-v2.9'',''question-generation-v2.10'',''question-generation-v2.11'',''question-generation-v2.12'',''question-generation-v2.13'') and exists('),
    ('public.stage_question_generation_candidates(uuid,uuid,jsonb,text,text,text,text,timestamp with time zone)',
      'perform public.validate_question_candidates(p_candidates,a.input_snapshot,a.image_snapshot,a.requested_question_count);',
      'if p_prompt_version<>''question-generation-v2.13'' and exists(select 1 from jsonb_array_elements(p_candidates) c where c->''answer_form''->>''kind''=''choice'') then raise exception ''Choice form requires choice schema'' using errcode=''22023''; end if; perform public.validate_question_candidates(p_candidates,a.input_snapshot,a.image_snapshot,a.requested_question_count);'),
    ('public.authorize_question_regeneration_dispatch(uuid,uuid,uuid,text,text,text)',
      'and p_schema_version=''why_box_question_regeneration_v1_1''),false)',
      'and p_schema_version=''why_box_question_regeneration_v1_1'') or (p_prompt_version=''question-regeneration-v1.8'' and p_schema_version=''why_box_question_regeneration_v1_2''),false)'),
    ('public.capture_followup_schema_version()',
      'case when new.prompt_version in',
      'case when new.prompt_version=''question-followup-v1.8'' then ''why_box_question_followup_v1_2'' when new.prompt_version in'),
    ('public.guard_regeneration_answer_form()',
      'if new.prompt_version in (''question-regeneration-v1.3''',
      'if new.prompt_version<>''question-regeneration-v1.8'' and new.candidate->''answer_form''->>''kind''=''choice'' then raise exception ''Choice form requires choice schema'' using errcode=''22023''; end if; if new.prompt_version=''question-regeneration-v1.8'' and (new.schema_version<>''why_box_question_regeneration_v1_2'' or not new.candidate ? ''answer_form'') then raise exception ''New regeneration requires choice schema'' using errcode=''22023''; end if; if new.prompt_version in (''question-regeneration-v1.3'''),
    ('public.finish_question_followup(uuid,text,text,text,integer,integer,text,jsonb)',
      '''question-followup-v1.6'',''question-followup-v1.7''',
      '''question-followup-v1.6'',''question-followup-v1.7'',''question-followup-v1.8'''),
    ('public.finish_question_followup(uuid,text,text,text,integer,integer,text,jsonb)',
      'if r.status in (''generated'',''no_followup'',''failed'',''outcome_unknown'') then',
      'if r.prompt_version<>''question-followup-v1.8'' and p_answer_form->>''kind''=''choice'' then raise exception ''Choice form requires choice schema'' using errcode=''22023''; end if; if r.status in (''generated'',''no_followup'',''failed'',''outcome_unknown'') then'),
    ('public.finish_question_followup(uuid,text,text,text,integer,integer,text,jsonb)',
      'schema_version=''why_box_question_followup_v1_1''',
      'schema_version=case when r.prompt_version=''question-followup-v1.8'' then ''why_box_question_followup_v1_2'' else ''why_box_question_followup_v1_1'' end')
  ) changes(signature,old_expression,new_expression)
  loop
    definition:=pg_get_functiondef(f.signature::regprocedure);
    revised:=replace(definition,f.old_expression,f.new_expression);
    if revised=definition then raise exception 'Unrecognized prompt guard %',f.signature; end if;
    execute revised;
  end loop;
end $$;

create function public.question_choice_answers_ready()
returns boolean language sql stable set search_path='' as $$ select true $$;
revoke all on function public.question_choice_answers_ready() from public,anon;
grant execute on function public.question_choice_answers_ready() to authenticated,service_role;
notify pgrst,'reload schema';
commit;
