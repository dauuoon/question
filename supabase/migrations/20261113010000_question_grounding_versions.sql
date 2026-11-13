begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Widen only the form-aware prompt pairs; historical versions and rows stay intact.
do $$
declare c record; definition text; revised text;
begin
  for c in select conrelid::regclass as relation,conname,pg_get_constraintdef(oid) as definition
    from pg_constraint where contype='c' and conrelid in (
      'public.question_generation_attempts'::regclass,'public.question_candidates'::regclass,
      'public.question_regeneration_dispatch_metadata'::regclass)
    and (pg_get_constraintdef(oid) like '%question-generation-v2.8%'
      or pg_get_constraintdef(oid) like '%question-regeneration-v1.3%')
  loop
    definition:=c.definition;
    revised:=replace(definition, '= ''question-generation-v2.8''::text',
      '= ANY (ARRAY[''question-generation-v2.8''::text,''question-generation-v2.9''::text])');
    -- The legacy-schema branch excludes every form-aware version.
    revised:=replace(revised, '<> ''question-generation-v2.8''::text',
      '<> ALL (ARRAY[''question-generation-v2.8''::text,''question-generation-v2.9''::text])');
    revised:=replace(revised, '''question-generation-v2.8''::text]',
      '''question-generation-v2.8''::text,''question-generation-v2.9''::text]');
    revised:=replace(revised, '= ''question-regeneration-v1.3''::text',
      '= ANY (ARRAY[''question-regeneration-v1.3''::text,''question-regeneration-v1.4''::text])');
    if revised=definition then raise exception 'Unrecognized prompt constraint %',c.conname; end if;
    execute format('alter table %s drop constraint %I',c.relation,c.conname);
    execute format('alter table %s add constraint %I %s',c.relation,c.conname,revised);
  end loop;
end $$;

-- Preserve the existing checked implementations, signatures, privileges and budgets.
do $$
declare f record; definition text; revised text;
begin
  for f in select signature,old_expression,new_expression from (values
    ('public.stage_question_generation_candidates(uuid,uuid,jsonb,text,text,text,text,timestamp with time zone)',
      'p_prompt_version=''question-generation-v2.8''',
      'p_prompt_version in (''question-generation-v2.8'',''question-generation-v2.9'')'),
    ('public.authorize_question_regeneration_dispatch(uuid,uuid,uuid,text,text,text)',
      'p_prompt_version=''question-regeneration-v1.3''',
      'p_prompt_version in (''question-regeneration-v1.3'',''question-regeneration-v1.4'')'),
    ('public.capture_followup_schema_version()',
      'new.prompt_version=''question-followup-v1.3''',
      'new.prompt_version in (''question-followup-v1.3'',''question-followup-v1.4'')'),
    ('public.guard_regeneration_answer_form()',
      'new.prompt_version=''question-regeneration-v1.3''',
      'new.prompt_version in (''question-regeneration-v1.3'',''question-regeneration-v1.4'')'),
    ('public.finish_question_followup(uuid,text,text,text,integer,integer,text,jsonb)',
      'r.prompt_version<>''question-followup-v1.3''',
      'r.prompt_version not in (''question-followup-v1.3'',''question-followup-v1.4'')')
  ) changes(signature,old_expression,new_expression)
  loop
    definition:=pg_get_functiondef(f.signature::regprocedure);
    revised:=replace(definition,f.old_expression,f.new_expression);
    if revised=definition then raise exception 'Unrecognized prompt guard %',f.signature; end if;
    execute revised;
  end loop;
end $$;

notify pgrst,'reload schema';
commit;
