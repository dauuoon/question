-- Run in the intended Production SQL Editor before AND after the new migration.
-- Save both results privately. This file never invokes completion or an AI API.
-- Compare data fingerprints during a quiet window, before T01 testing.
-- Concurrent legitimate writes change fingerprints too; a difference is a STOP
-- signal for investigation, not evidence that the migration changed data.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '30s';
set local lock_timeout = '3s';

select current_database() as database_name, current_user as executing_role,
  transaction_timestamp() as observed_at, current_setting('transaction_read_only') as read_only;

-- Save the ORIGINAL definition separately for a separately approved restoration.
-- Definition output contains schema code only, not participant answers.
select p.oid::regprocedure::text as signature,
  pg_get_userbyid(p.proowner) as owner,
  l.lanname as language, p.prosecdef as security_definer,
  p.provolatile as volatility, p.proconfig as configuration,
  p.proacl::text as acl, pg_get_function_result(p.oid) as result_type,
  md5(pg_get_functiondef(p.oid)) as definition_md5,
  pg_get_functiondef(p.oid) as definition,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute,
  exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 0 and a.privilege_type = 'EXECUTE'
  ) as public_execute
from pg_proc p join pg_language l on l.oid = p.prolang
where p.oid = to_regprocedure('public.session_briefing_input_snapshot(uuid)');

-- These definitions MUST remain unchanged across the function-only migration.
select p.oid::regprocedure::text as signature,
  pg_get_userbyid(p.proowner) as owner, p.proacl::text as acl,
  p.prosecdef as security_definer, p.proconfig as configuration,
  md5(pg_get_functiondef(p.oid)) as definition_md5
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in (
  'begin_session_completion', 'authorize_session_briefing_dispatch',
  'finish_session_briefing', 'fail_session_briefing'
)
order by signature;

-- Deterministic row digests: no research text or participant identifiers output.
-- MD5 here is a change detector, NOT a backup or a security/integrity guarantee.
with research_rows(table_name, row_data) as (
  select 'profiles', to_jsonb(t) from public.profiles t union all
  select 'sessions', to_jsonb(t) from public.sessions t union all
  select 'questions', to_jsonb(t) from public.questions t union all
  select 'answers', to_jsonb(t) from public.answers t union all
  select 'session_contexts', to_jsonb(t) from public.session_contexts t union all
  select 'session_images', to_jsonb(t) from public.session_images t union all
  select 'question_followup_requests', to_jsonb(t) from public.question_followup_requests t union all
  select 'session_briefing_requests', to_jsonb(t) from public.session_briefing_requests t union all
  select 'session_briefing_sources', to_jsonb(t) from public.session_briefing_sources t union all
  select 'session_briefing_versions', to_jsonb(t) from public.session_briefing_versions t union all
  select 'session_diary_prompt_shown', to_jsonb(t) from public.session_diary_prompt_shown t union all
  select 'diaries', to_jsonb(t) from public.diaries t
), names(table_name) as (
  values ('profiles'), ('sessions'), ('questions'), ('answers'),
    ('session_contexts'), ('session_images'), ('question_followup_requests'),
    ('session_briefing_requests'), ('session_briefing_sources'),
    ('session_briefing_versions'), ('session_diary_prompt_shown'), ('diaries')
), hashes as (
  select table_name, md5(row_data::text) as row_hash from research_rows
)
select n.table_name, count(h.row_hash) as row_count,
  md5(coalesce(string_agg(h.row_hash, '' order by h.row_hash), '')) as content_fingerprint
from names n left join hashes h using (table_name)
group by n.table_name order by n.table_name;

select status, count(*) as session_count from public.sessions group by status order by status;
select state, count(*) as request_count from public.session_briefing_requests group by state order by state;
commit;
