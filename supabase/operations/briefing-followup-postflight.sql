-- Run after the NEW app is deployed and the separately approved SQL is applied.
-- Read-only catalog/shape checks; never create snapshots, dispatch, retry or AI calls.
-- All permission checks must be true. Shape violation counts must be zero.
-- A nested count of zero before T01 testing is normal (no backfill).
begin transaction isolation level repeatable read read only;
set local statement_timeout = '30s';
set local lock_timeout = '3s';

select
  count(*) = 1 as snapshot_function_present,
  coalesce(bool_and(pg_get_userbyid(p.proowner) = 'postgres'), false) as postgres_owner,
  coalesce(bool_and(p.prosecdef), false) as security_definer,
  coalesce(bool_and(p.provolatile = 's'), false) as stable,
  coalesce(bool_and(l.lanname = 'sql'), false) as sql_language,
  coalesce(bool_and(pg_get_function_result(p.oid) = 'jsonb'), false) as jsonb_result,
  coalesce(bool_and('search_path=""' = any(p.proconfig)), false) as empty_search_path,
  coalesce(bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE')
    and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and not has_function_privilege('service_role', p.oid, 'EXECUTE')
    and not exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE'
    )), false) as private_execute
from pg_proc p join pg_language l on l.oid = p.prolang
where p.oid = to_regprocedure('public.session_briefing_input_snapshot(uuid)');

-- Version hint only: also compare the FULL definition from the pre/post audit
-- against the approved new migration. String matching alone is not proof.
select position('left join lateral' in lower(pg_get_functiondef(p.oid))) > 0 as nested_join_present,
  position('parent_question_id' in pg_get_functiondef(p.oid)) > 0 as parent_link_present,
  position('fa.participant_id = s.participant_id' in pg_get_functiondef(p.oid)) > 0 as child_owner_filter_present
from pg_proc p
where p.oid = to_regprocedure('public.session_briefing_input_snapshot(uuid)');

with entries as (
  select r.session_id, q.value as parent
  from public.session_briefing_requests r
  cross join lateral jsonb_array_elements(r.input_snapshot->'answered_questions') q
), nested as (
  select session_id, parent, parent->'followup' as child from entries
  where parent ? 'followup'
)
select count(*) as stored_nested_children,
  count(*) filter (where child->>'session_id' is distinct from session_id::text
    or child->>'parent_question_id' is distinct from parent->>'question_id'
    or child->>'question_id' = parent->>'question_id'
    or coalesce(child->>'question_id', '') = '') as invalid_lineage,
  count(*) filter (where coalesce(child->'answer'->>'selected', '') ~ '^[[:space:]]*$'
    or child->'answer'->>'current_version' is null
    or child->'answer'->>'current_version' not in ('original', 'refined')
    or child->'answer'->>'selected' is distinct from
      case when child->'answer'->>'current_version' = 'refined'
        then child->'answer'->>'refined' else child->'answer'->>'original' end
  ) as invalid_selected_answer
from nested;

-- Informational: old and new sources may coexist; do not regenerate old sources.
select prompt_version, schema_version, count(*) as source_count
from public.session_briefing_sources
group by prompt_version, schema_version order by prompt_version, schema_version;
commit;
