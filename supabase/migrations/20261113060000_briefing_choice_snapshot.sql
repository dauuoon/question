begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create function public.briefing_choice_selection(form jsonb, fields text[], answer_version text)
returns jsonb language sql immutable set search_path='' as $$
  select case when form->>'kind'='choice' and answer_version='original' and fields is not null then
    jsonb_build_object(
      'selected_options', coalesce((
        select jsonb_agg(fields[i] order by i)
        from generate_series(1,cardinality(fields)-2) i
        where fields[i]<>''
      ),'[]'::jsonb),
      'other', fields[cardinality(fields)-1],
      'explanation', fields[cardinality(fields)]
    )
  else null end;
$$;
alter function public.briefing_choice_selection(jsonb,text[],text) owner to postgres;
revoke all on function public.briefing_choice_selection(jsonb,text[],text) from public,anon,authenticated,service_role;

do $body$
declare definition text; revised text;
begin
  if not exists(select 1 from pg_proc p join pg_roles r on r.oid=p.proowner
    where p.oid=to_regprocedure('public.session_briefing_input_snapshot(uuid)') and r.rolname='postgres')
    or has_function_privilege('authenticated','public.session_briefing_input_snapshot(uuid)','EXECUTE')
    or has_function_privilege('service_role','public.session_briefing_input_snapshot(uuid)','EXECUTE')
  then raise exception 'Expected private briefing snapshot function'; end if;
  select pg_get_functiondef('public.session_briefing_input_snapshot(uuid)'::regprocedure) into definition;
  revised:=replace(definition,
    $old$'selected', case when a.current_answer_version = 'refined'
              then a.refined_answer else a.original_answer end
          )$old$,
    $new$'selected', case when a.current_answer_version = 'refined'
              then a.refined_answer else a.original_answer end
          ) || case when public.briefing_choice_selection(q.answer_form,a.original_answer_fields,a.current_answer_version) is null then '{}'::jsonb else jsonb_build_object('choice_selection',public.briefing_choice_selection(q.answer_form,a.original_answer_fields,a.current_answer_version)) end$new$);
  if revised=definition then raise exception 'Parent snapshot structure changed'; end if;
  definition:=revised;
  revised:=replace(definition,
    $old$'selected', case when fa.current_answer_version = 'refined'
              then fa.refined_answer else fa.original_answer end
          )$old$,
    $new$'selected', case when fa.current_answer_version = 'refined'
              then fa.refined_answer else fa.original_answer end
          ) || case when public.briefing_choice_selection(fq.answer_form,fa.original_answer_fields,fa.current_answer_version) is null then '{}'::jsonb else jsonb_build_object('choice_selection',public.briefing_choice_selection(fq.answer_form,fa.original_answer_fields,fa.current_answer_version)) end$new$);
  if revised=definition then raise exception 'Follow-up snapshot structure changed'; end if;
  execute revised;
end $body$;

create function public.briefing_choice_snapshot_ready()
returns boolean language sql stable set search_path='' as $$ select true $$;
revoke all on function public.briefing_choice_snapshot_ready() from public,anon;
grant execute on function public.briefing_choice_snapshot_ready() to authenticated,service_role;
commit;
