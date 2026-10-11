-- Read-only. First section follows the migration; final section follows P01 -> T01.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '20s';
select column_name, data_type, is_nullable, column_default
from information_schema.columns where table_schema = 'public'
  and table_name = 'profiles' and column_name = 'account_type';
-- Immediately after migration: all old rows NULL; events empty.
-- After conversion: exactly the target T row and one NULL -> T event.
select role, account_type, count(*) from public.profiles group by role, account_type;
select count(*) as classification_events from public.account_type_events;
select conname, convalidated, pg_get_constraintdef(oid) as definition
from pg_constraint where conrelid in ('public.profiles'::regclass, 'public.account_type_events'::regclass)
order by conrelid, conname;
select relrowsecurity, pg_get_userbyid(relowner) as owner from pg_class
where oid = 'public.account_type_events'::regclass;
select policyname, roles, cmd, qual, with_check from pg_policies
where schemaname = 'public' and tablename = 'account_type_events';
select rolname,
  has_function_privilege(rolname, 'public.change_participant_account_type(uuid,text,text,text)', 'EXECUTE') as rpc_execute,
  has_function_privilege(rolname, 'public.record_account_type_event()', 'EXECUTE') as recorder_execute,
  has_table_privilege(rolname, 'public.account_type_events', 'SELECT') as events_select,
  has_table_privilege(rolname, 'public.account_type_events', 'INSERT,UPDATE,DELETE,TRUNCATE') as any_events_write,
  has_column_privilege(rolname, 'public.profiles', 'account_type', 'UPDATE') as type_update
from pg_roles where rolname in ('anon', 'authenticated', 'service_role');
select tgrelid::regclass as table_name, tgname, tgenabled, pg_get_triggerdef(oid) as definition
from pg_trigger where tgrelid in ('public.profiles'::regclass, 'public.account_type_events'::regclass)
  and not tgisinternal;
select proname, prosecdef, proconfig, pg_get_userbyid(proowner) as owner, proacl
from pg_proc where oid in (
  'public.change_participant_account_type(uuid,text,text,text)'::regprocedure,
  'public.record_account_type_event()'::regprocedure,
  'public.guard_account_type_events()'::regprocedure);
-- No password, email, token or full Auth row is returned.
select
  exists (select 1 from public.profiles where id = '89507e34-b4fa-464a-b359-316be9a6bdcb'
    and role = 'admin' and status = 'active' and participant_code is null and account_type is null) as admin_preserved,
  exists (select 1 from public.profiles where id = 'ec0bba1e-3720-4200-a5e1-aed0673d2c32'
    and participant_code = 'T01' and account_type = 'T' and role = 'participant' and status = 'active') as target_t01,
  exists (select 1 from auth.users where id = 'ec0bba1e-3720-4200-a5e1-aed0673d2c32'
    and email = 't01@participants.whybox.invalid' and email_confirmed_at is not null) as target_auth_t01,
  not exists (select 1 from public.profiles where upper(participant_code) = 'P01') as old_code_absent;
select participant_id, previous_type, account_type, changed_at
from public.account_type_events where participant_id = 'ec0bba1e-3720-4200-a5e1-aed0673d2c32';
select id, participant_id, status from public.sessions
where participant_id = 'ec0bba1e-3720-4200-a5e1-aed0673d2c32' order by id;
-- Compare counts AND private row/path baselines; equal counts alone do not prove preservation.
select 'profiles' as table_name, count(*) as rows from public.profiles
union all select 'sessions', count(*) from public.sessions
union all select 'session_contexts', count(*) from public.session_contexts
union all select 'session_images', count(*) from public.session_images
union all select 'questions', count(*) from public.questions
union all select 'answers', count(*) from public.answers
union all select 'question_events', count(*) from public.question_events
union all select 'diaries', count(*) from public.diaries
union all select 'session_briefing_versions', count(*) from public.session_briefing_versions
union all select 'storage_objects', count(*) from storage.objects;
-- Preexisting policies and UUID relationships must match the preflight snapshot.
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies where schemaname in ('public', 'storage')
  and tablename <> 'account_type_events' order by schemaname, tablename, policyname;
select conrelid::regclass as table_name, conname, convalidated, pg_get_constraintdef(oid) as definition
from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace
order by conrelid, conname;
rollback;
