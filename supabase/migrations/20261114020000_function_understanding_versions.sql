begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

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
      '(prompt_version = ''question-generation-v2.14''::text) AND (schema_version = ''why_box_question_generation_v2_3''::text)',
      '((prompt_version = ''question-generation-v2.14''::text) OR (prompt_version = ''question-generation-v2.15''::text)) AND (schema_version = ''why_box_question_generation_v2_3''::text)');
    revised:=replace(revised,
      '(prompt_version = ''question-regeneration-v1.9''::text) AND (schema_version = ''why_box_question_regeneration_v1_3''::text)',
      '((prompt_version = ''question-regeneration-v1.9''::text) OR (prompt_version = ''question-regeneration-v1.10''::text)) AND (schema_version = ''why_box_question_regeneration_v1_3''::text)');
    if c.conname='question_candidates_prompt_version_check' then
      revised:=replace(revised,'''question-generation-v2.14''::text',
        '''question-generation-v2.14''::text, ''question-generation-v2.15''::text');
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
      '''question-generation-v2.14''', '''question-generation-v2.14'',''question-generation-v2.15'''),
    ('public.authorize_question_regeneration_dispatch(uuid,uuid,uuid,text,text,text)',
      '(p_prompt_version=''question-regeneration-v1.9'' and p_schema_version=''why_box_question_regeneration_v1_3'')',
      '(p_prompt_version in (''question-regeneration-v1.9'',''question-regeneration-v1.10'') and p_schema_version=''why_box_question_regeneration_v1_3'')'),
    ('public.capture_followup_schema_version()',
      'new.prompt_version=''question-followup-v1.9''',
      'new.prompt_version in (''question-followup-v1.9'',''question-followup-v1.10'')'),
    ('public.guard_regeneration_answer_form()',
      'new.prompt_version=''question-regeneration-v1.9''',
      'new.prompt_version in (''question-regeneration-v1.9'',''question-regeneration-v1.10'')'),
    ('public.guard_regeneration_answer_form()',
      '''question-regeneration-v1.8'',''question-regeneration-v1.9''',
      '''question-regeneration-v1.8'',''question-regeneration-v1.9'',''question-regeneration-v1.10'''),
    ('public.finish_question_followup(uuid,text,text,text,integer,integer,text,jsonb)',
      'r.prompt_version=''question-followup-v1.9''',
      'r.prompt_version in (''question-followup-v1.9'',''question-followup-v1.10'')'),
    ('public.finish_question_followup(uuid,text,text,text,integer,integer,text,jsonb)',
      '''question-followup-v1.8'',''question-followup-v1.9''',
      '''question-followup-v1.8'',''question-followup-v1.9'',''question-followup-v1.10''')
  ) changes(signature,old_expression,new_expression)
  loop
    definition:=pg_get_functiondef(f.signature::regprocedure);
    if f.signature like 'public.stage_question_generation_candidates%' then
      revised:=replace(definition,
        '(p_prompt_version=''question-generation-v2.14'' and p_schema_version=''why_box_question_generation_v2_3'')',
        '(p_prompt_version in (''question-generation-v2.14'',''question-generation-v2.15'') and p_schema_version=''why_box_question_generation_v2_3'')');
      revised:=replace(revised,
        'p_prompt_version=''question-generation-v2.14'' and exists',
        'p_prompt_version in (''question-generation-v2.14'',''question-generation-v2.15'') and exists');
      revised:=replace(revised,
        '''question-generation-v2.13'',''question-generation-v2.14''',
        '''question-generation-v2.13'',''question-generation-v2.14'',''question-generation-v2.15''');
    else
      revised:=replace(definition,f.old_expression,f.new_expression);
    end if;
    if revised=definition then raise exception 'Unrecognized version guard %',f.signature; end if;
    execute revised;
  end loop;
end $$;

notify pgrst,'reload schema';
commit;
