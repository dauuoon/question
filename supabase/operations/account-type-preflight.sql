-- Read-only. Run before migration and BEFORE the Auth P01 -> T01 change.
-- Project identity must also be checked in the dashboard/connection URL.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '20s';
select
  (select count(*) = 1 from public.profiles where role = 'admin') as one_admin,
  exists (select 1 from public.profiles where id = '89507e34-b4fa-464a-b359-316be9a6bdcb'
    and role = 'admin' and status = 'active' and participant_code is null) as protected_admin,
  exists (select 1 from auth.users where id = '89507e34-b4fa-464a-b359-316be9a6bdcb') as admin_auth_present,
  exists (select 1 from public.profiles where id = 'ec0bba1e-3720-4200-a5e1-aed0673d2c32'
    and role = 'participant' and status = 'active' and participant_code = 'P01') as exact_p01_profile,
  exists (select 1 from auth.users where id = 'ec0bba1e-3720-4200-a5e1-aed0673d2c32'
    and email = 'p01@participants.whybox.invalid' and email_confirmed_at is not null) as exact_p01_auth,
  not exists (select 1 from public.profiles where upper(participant_code) = 'T01') as t01_code_free,
  not exists (select 1 from auth.users where lower(email) = 't01@participants.whybox.invalid') as t01_auth_free,
  not exists (select 1 from auth.identities where provider = 'email'
    and lower(identity_data->>'email') = 't01@participants.whybox.invalid') as t01_identity_free;

select
  not exists (select 1 from pg_attribute where attrelid = 'public.profiles'::regclass
    and attname = 'account_type' and not attisdropped) as new_column_absent,
  to_regclass('public.account_type_events') is null as new_table_absent,
  to_regprocedure('public.change_participant_account_type(uuid,text,text,text)') is null as new_rpc_absent,
  to_regprocedure('public.record_account_type_event()') is null as new_recorder_absent,
  to_regprocedure('public.guard_account_type_events()') is null as new_guard_absent,
  not exists (select 1 from public.profiles where participant_code is not null
    and participant_code !~ '^[PT][0-9]{2,}$') as existing_codes_valid;
select conname, convalidated, pg_get_constraintdef(oid) as definition
from pg_constraint where conrelid = 'public.profiles'::regclass order by conname;
select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'profiles';
select c.relname, c.relrowsecurity, pg_get_userbyid(c.relowner) as owner, c.relacl
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('profiles', 'sessions', 'diaries');
select rolname,
  has_table_privilege(rolname, 'public.profiles', 'SELECT') as can_select,
  has_table_privilege(rolname, 'public.profiles', 'INSERT') as can_insert,
  has_table_privilege(rolname, 'public.profiles', 'UPDATE') as can_update,
  has_table_privilege(rolname, 'public.profiles', 'DELETE') as can_delete
from pg_roles where rolname in ('anon', 'authenticated', 'service_role');
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies where schemaname in ('public', 'storage') order by schemaname, tablename, policyname;
select tgname, tgenabled, pg_get_triggerdef(oid) as definition
from pg_trigger where tgrelid = 'public.profiles'::regclass and not tgisinternal;
select proname, prosecdef, proconfig, pg_get_userbyid(proowner) as owner, proacl,
  pg_get_functiondef(oid) as definition
from pg_proc where oid in (to_regprocedure('public.is_active_admin()'),
  to_regprocedure('public.owns_session(uuid)'));
-- Migration history is inspected separately if this relation exists.
select to_regclass('supabase_migrations.schema_migrations') as migration_history_table;
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
rollback;
