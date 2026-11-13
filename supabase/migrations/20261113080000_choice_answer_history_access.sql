begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

drop policy choice_answer_history_select on public.choice_answer_history;
create policy choice_answer_history_select on public.choice_answer_history
  for select to authenticated using (
    exists (select 1 from public.questions q
      where q.id=question_id and (select public.owns_session(q.session_id)))
    or (select public.is_active_admin())
  );
create function public.choice_answer_history_access_ready()
returns boolean language sql stable set search_path='' as $$ select true $$;
revoke all on function public.choice_answer_history_access_ready() from public, anon;
grant execute on function public.choice_answer_history_access_ready() to authenticated, service_role;
notify pgrst,'reload schema';
commit;
