begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Only append prompt identifiers to the existing paired-version arrays.
do $$
declare c record; revised text;
begin
  for c in select conrelid::regclass as relation,conname,pg_get_constraintdef(oid) as definition
    from pg_constraint where contype='c' and conrelid in (
      'public.question_generation_attempts'::regclass,'public.question_candidates'::regclass,
      'public.question_regeneration_dispatch_metadata'::regclass)
    and (pg_get_constraintdef(oid) like '%question-generation-v2.11%'
      or pg_get_constraintdef(oid) like '%question-regeneration-v1.6%')
  loop
    revised:=replace(c.definition,'''question-generation-v2.11''::text',
      '''question-generation-v2.11''::text, ''question-generation-v2.12''::text');
    revised:=replace(revised,'''question-regeneration-v1.6''::text',
      '''question-regeneration-v1.6''::text, ''question-regeneration-v1.7''::text');
    if revised=c.definition then raise exception 'Unrecognized prompt constraint %',c.conname; end if;
    execute format('alter table %s drop constraint %I',c.relation,c.conname);
    execute format('alter table %s add constraint %I %s',c.relation,c.conname,revised);
  end loop;
end $$;

-- Retain checked implementations, signatures, privileges and call budgets.
do $$
declare f record; definition text; revised text;
begin
  for f in select signature,old_expression,new_expression from (values
    ('public.stage_question_generation_candidates(uuid,uuid,jsonb,text,text,text,text,timestamp with time zone)',
      '''question-generation-v2.10'',''question-generation-v2.11''',
      '''question-generation-v2.10'',''question-generation-v2.11'',''question-generation-v2.12'''),
    ('public.authorize_question_regeneration_dispatch(uuid,uuid,uuid,text,text,text)',
      '''question-regeneration-v1.5'',''question-regeneration-v1.6''',
      '''question-regeneration-v1.5'',''question-regeneration-v1.6'',''question-regeneration-v1.7'''),
    ('public.capture_followup_schema_version()',
      '''question-followup-v1.5'',''question-followup-v1.6''',
      '''question-followup-v1.5'',''question-followup-v1.6'',''question-followup-v1.7'''),
    ('public.guard_regeneration_answer_form()',
      '''question-regeneration-v1.5'',''question-regeneration-v1.6''',
      '''question-regeneration-v1.5'',''question-regeneration-v1.6'',''question-regeneration-v1.7'''),
    ('public.finish_question_followup(uuid,text,text,text,integer,integer,text,jsonb)',
      '''question-followup-v1.5'',''question-followup-v1.6''',
      '''question-followup-v1.5'',''question-followup-v1.6'',''question-followup-v1.7''')
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
