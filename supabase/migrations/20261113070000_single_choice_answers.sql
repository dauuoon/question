begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table public.choice_answer_history (
  id bigint generated always as identity primary key,
  answer_id uuid not null references public.answers(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete restrict,
  participant_id uuid not null references public.profiles(id) on delete restrict,
  original_answer text not null,
  original_answer_fields text[],
  refined_answer text,
  current_answer_version text not null,
  answer_updated_at timestamptz not null,
  archived_at timestamptz not null default now()
);
alter table public.choice_answer_history enable row level security;
revoke all on public.choice_answer_history from public, anon, authenticated;
grant select on public.choice_answer_history to authenticated;
create policy choice_answer_history_select on public.choice_answer_history
  for select to authenticated using (participant_id = (select auth.uid()));

create function public.guard_single_choice_answer()
returns trigger language plpgsql security definer set search_path='' as $$
declare form jsonb; n integer; selected_count integer; changed boolean;
begin
  select q.answer_form into form from public.questions q where q.id=new.question_id;
  if form->>'kind' is distinct from 'choice' then return new; end if;
  changed := tg_op='INSERT';
  if tg_op='UPDATE' then
    changed := new.original_answer is distinct from old.original_answer
      or new.original_answer_fields is distinct from old.original_answer_fields;
    if not changed then return new; end if;
  end if;
  if new.original_answer_fields is null then
    if new.original_answer<>'' then
      raise exception 'Choice answer requires structured fields' using errcode='22023';
    end if;
  else
    n:=cardinality(new.original_answer_fields);
    if n<>jsonb_array_length(form->'labels') or new.original_answer_fields[n]<>'' then
      raise exception 'Choice answer cannot contain an explanation' using errcode='22023';
    end if;
    select count(*) into selected_count from generate_series(1,n-2) i
      where new.original_answer_fields[i]<>'';
    if new.original_answer_fields[n-1] !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]*$'
      then selected_count:=selected_count+1; end if;
    if selected_count>1 then raise exception 'Choice answer allows only one selection' using errcode='22023'; end if;
  end if;
  if tg_op='UPDATE' and (old.original_answer<>'' or old.original_answer_fields is not null) then
    insert into public.choice_answer_history(answer_id,question_id,participant_id,original_answer,
      original_answer_fields,refined_answer,current_answer_version,answer_updated_at)
    values(old.id,old.question_id,old.participant_id,old.original_answer,old.original_answer_fields,
      old.refined_answer,old.current_answer_version,old.updated_at);
  end if;
  return new;
end $$;
alter function public.guard_single_choice_answer() owner to postgres;
revoke all on function public.guard_single_choice_answer() from public, anon, authenticated, service_role;
create trigger answers_03_single_choice before insert or update on public.answers
  for each row execute function public.guard_single_choice_answer();

do $$
declare c record; revised text;
begin
  for c in select conrelid::regclass relation,conname,pg_get_constraintdef(oid) definition
    from pg_constraint where conname in ('question_generation_attempts_prompt_metadata_check',
      'question_candidates_prompt_version_check','question_candidates_schema_version_check',
      'question_regeneration_dispatch_metadata_prompt_version_check')
      and conrelid in ('public.question_generation_attempts'::regclass,'public.question_candidates'::regclass,
        'public.question_regeneration_dispatch_metadata'::regclass)
  loop
    revised:=replace(c.definition,
      '(prompt_version = ''question-generation-v2.13''::text) AND (schema_version = ''why_box_question_generation_v2_2''::text)',
      '((prompt_version = ''question-generation-v2.13''::text) AND (schema_version = ''why_box_question_generation_v2_2''::text)) OR ((prompt_version = ''question-generation-v2.14''::text) AND (schema_version = ''why_box_question_generation_v2_3''::text))');
    revised:=replace(revised,
      '(prompt_version = ''question-regeneration-v1.8''::text) AND (schema_version = ''why_box_question_regeneration_v1_2''::text)',
      '((prompt_version = ''question-regeneration-v1.8''::text) AND (schema_version = ''why_box_question_regeneration_v1_2''::text)) OR ((prompt_version = ''question-regeneration-v1.9''::text) AND (schema_version = ''why_box_question_regeneration_v1_3''::text))');
    if c.conname='question_candidates_prompt_version_check' then
      revised:=replace(revised,'''question-generation-v2.13''::text',
        '''question-generation-v2.13''::text, ''question-generation-v2.14''::text');
    end if;
    if revised=c.definition then raise exception 'Unrecognized version constraint %',c.conname; end if;
    execute format('alter table %s drop constraint %I',c.relation,c.conname);
    execute format('alter table %s add constraint %I %s',c.relation,c.conname,revised);
  end loop;
end $$;

do $$
declare f record; definition text; revised text;
begin
  for f in select signature,old_expression,new_expression from (values
    ('public.stage_question_generation_candidates(uuid,uuid,jsonb,text,text,text,text,timestamp with time zone)',
      'p_prompt_version<>''question-generation-v2.13''',
      'p_prompt_version not in (''question-generation-v2.13'',''question-generation-v2.14'')'),
    ('public.stage_question_generation_candidates(uuid,uuid,jsonb,text,text,text,text,timestamp with time zone)',
      'perform public.validate_question_candidates(p_candidates,a.input_snapshot,a.image_snapshot,a.requested_question_count);',
      'if p_prompt_version=''question-generation-v2.14'' and exists(select 1 from jsonb_array_elements(p_candidates) c where c->''answer_form''->>''kind''=''choice'' and c->''answer_form''->>''max_selections''<>''1'') then raise exception ''Single choice form required'' using errcode=''22023''; end if; perform public.validate_question_candidates(p_candidates,a.input_snapshot,a.image_snapshot,a.requested_question_count);'),
    ('public.stage_question_generation_candidates(uuid,uuid,jsonb,text,text,text,text,timestamp with time zone)',
      '(p_prompt_version=''question-generation-v2.13'' and p_schema_version=''why_box_question_generation_v2_2'')',
      '((p_prompt_version=''question-generation-v2.13'' and p_schema_version=''why_box_question_generation_v2_2'') or (p_prompt_version=''question-generation-v2.14'' and p_schema_version=''why_box_question_generation_v2_3''))'),
    ('public.stage_question_generation_candidates(uuid,uuid,jsonb,text,text,text,text,timestamp with time zone)',
      '''question-generation-v2.12'',''question-generation-v2.13'') and exists(',
      '''question-generation-v2.12'',''question-generation-v2.13'',''question-generation-v2.14'') and exists('),
    ('public.authorize_question_regeneration_dispatch(uuid,uuid,uuid,text,text,text)',
      '(p_prompt_version=''question-regeneration-v1.8'' and p_schema_version=''why_box_question_regeneration_v1_2'')',
      '((p_prompt_version=''question-regeneration-v1.8'' and p_schema_version=''why_box_question_regeneration_v1_2'') or (p_prompt_version=''question-regeneration-v1.9'' and p_schema_version=''why_box_question_regeneration_v1_3''))'),
    ('public.capture_followup_schema_version()',
      'case when new.prompt_version=''question-followup-v1.8'' then',
      'case when new.prompt_version=''question-followup-v1.9'' then ''why_box_question_followup_v1_3'' when new.prompt_version=''question-followup-v1.8'' then'),
    ('public.guard_regeneration_answer_form()',
      'new.prompt_version<>''question-regeneration-v1.8''',
      'new.prompt_version not in (''question-regeneration-v1.8'',''question-regeneration-v1.9'')'),
    ('public.guard_regeneration_answer_form()',
      'if new.prompt_version=''question-regeneration-v1.8'' and',
      'if new.prompt_version=''question-regeneration-v1.9'' and (new.schema_version<>''why_box_question_regeneration_v1_3'' or not new.candidate ? ''answer_form'' or (new.candidate->''answer_form''->>''kind''=''choice'' and new.candidate->''answer_form''->>''max_selections''<>''1'')) then raise exception ''New regeneration requires single choice schema'' using errcode=''22023''; end if; if new.prompt_version=''question-regeneration-v1.8'' and'),
    ('public.finish_question_followup(uuid,text,text,text,integer,integer,text,jsonb)',
      'r.prompt_version<>''question-followup-v1.8''',
      'r.prompt_version not in (''question-followup-v1.8'',''question-followup-v1.9'')'),
    ('public.finish_question_followup(uuid,text,text,text,integer,integer,text,jsonb)',
      'if r.status in (''generated'',''no_followup'',''failed'',''outcome_unknown'') then',
      'if r.prompt_version=''question-followup-v1.9'' and p_answer_form->>''kind''=''choice'' and p_answer_form->>''max_selections''<>''1'' then raise exception ''Single choice form required'' using errcode=''22023''; end if; if r.status in (''generated'',''no_followup'',''failed'',''outcome_unknown'') then'),
    ('public.finish_question_followup(uuid,text,text,text,integer,integer,text,jsonb)',
      '''question-followup-v1.7'',''question-followup-v1.8'')',
      '''question-followup-v1.7'',''question-followup-v1.8'',''question-followup-v1.9'')'),
    ('public.finish_question_followup(uuid,text,text,text,integer,integer,text,jsonb)',
      'case when r.prompt_version=''question-followup-v1.8'' then',
      'case when r.prompt_version=''question-followup-v1.9'' then ''why_box_question_followup_v1_3'' when r.prompt_version=''question-followup-v1.8'' then')
  ) changes(signature,old_expression,new_expression)
  loop
    definition:=pg_get_functiondef(f.signature::regprocedure);
    revised:=replace(definition,f.old_expression,f.new_expression);
    if revised=definition then raise exception 'Unrecognized version guard %',f.signature; end if;
    execute revised;
  end loop;
end $$;

create function public.single_choice_answers_ready()
returns boolean language sql stable set search_path='' as $$ select true $$;
revoke all on function public.single_choice_answers_ready() from public, anon;
grant execute on function public.single_choice_answers_ready() to authenticated, service_role;
notify pgrst,'reload schema';
commit;
