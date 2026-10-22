-- Run the whole file in the intended project's SQL Editor.
-- Returns one JSON result; reads catalog definitions, never application rows.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '20s';
set local lock_timeout = '3s';

with tables as (
  select c.*, n.nspname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and c.relname in (
      'profiles', 'sessions', 'questions', 'answers', 'question_targets',
      'question_events', 'question_action_requests', 'question_regeneration_requests',
      'question_regeneration_attempts', 'question_regeneration_candidates',
      'question_regeneration_events', 'question_followup_requests'
    )
),
functions as (
  select p.* from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where p.prokind = 'f' and (
    (n.nspname = 'public' and p.proname in (
      'is_active_admin', 'owns_session', 'read_question_action_capabilities',
      'guard_question_followup_history', 'guard_question_followup_answer_lock',
      'guard_question_followup_question_lock', 'guard_question_followup_conflicting_action',
      'begin_question_followup', 'dispatch_question_followup', 'finish_question_followup'
    ))
    or p.oid in (
      select t.tgfoid from pg_trigger t
      where t.tgrelid in (select oid from tables) and not t.tgisinternal
    )
  )
),
items(section, detail) as (
  select 'tables', jsonb_build_object(
    'name', c.relname, 'owner', pg_get_userbyid(c.relowner),
    'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity, 'acl', c.relacl
  ) from tables c
  union all
  select 'columns', jsonb_build_object(
    'table', c.relname, 'name', a.attname,
    'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
    'default', pg_get_expr(d.adbin, d.adrelid)
  ) from tables c join pg_attribute a on a.attrelid = c.oid
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attnum > 0 and not a.attisdropped
  union all
  select 'constraints', jsonb_build_object(
    'table', c.relname, 'name', k.conname, 'validated', k.convalidated,
    'definition', pg_get_constraintdef(k.oid, true)
  ) from tables c join pg_constraint k on k.conrelid = c.oid
  union all
  select 'indexes', jsonb_build_object(
    'table', c.relname, 'name', idx.relname, 'valid', i.indisvalid,
    'ready', i.indisready, 'definition', pg_get_indexdef(i.indexrelid)
  ) from pg_index i join pg_class c on c.oid = i.indrelid
  join pg_class idx on idx.oid = i.indexrelid
  join pg_namespace n on n.oid = idx.relnamespace
  where c.oid in (select oid from tables) or (
    n.nspname = 'public' and idx.relname in (
      'question_followup_one_pending_per_root',
      'question_followup_one_success_per_root', 'question_followup_answer_outcome_unique'
    )
  )
  union all
  select 'triggers', jsonb_build_object(
    'table', c.relname, 'name', t.tgname, 'enabled', t.tgenabled,
    'function', t.tgfoid::regprocedure::text,
    'definition', pg_get_triggerdef(t.oid, true)
  ) from tables c join pg_trigger t on t.tgrelid = c.oid
  where not t.tgisinternal
  union all
  select 'functions', jsonb_build_object(
    'signature', p.oid::regprocedure::text, 'owner', pg_get_userbyid(p.proowner),
    'security_definer', p.prosecdef, 'config', p.proconfig,
    'acl', p.proacl, 'definition', pg_get_functiondef(p.oid)
  ) from functions p
  union all
  select 'policies', to_jsonb(p)
  from pg_policies p where p.schemaname = 'public'
    and p.tablename in (select relname from tables)
  union all
  select 'table_privileges', jsonb_build_object(
    'table', c.relname, 'role', r.rolname, 'bypass_rls', r.rolbypassrls,
    'superuser', r.rolsuper,
    'schema_usage', has_schema_privilege(r.oid, c.relnamespace, 'USAGE'),
    'select', has_table_privilege(r.oid, c.oid, 'SELECT'),
    'insert', has_table_privilege(r.oid, c.oid, 'INSERT'),
    'update', has_table_privilege(r.oid, c.oid, 'UPDATE'),
    'delete', has_table_privilege(r.oid, c.oid, 'DELETE'),
    'truncate', has_table_privilege(r.oid, c.oid, 'TRUNCATE')
  ) from tables c cross join pg_roles r
  where r.rolname in ('anon', 'authenticated', 'service_role')
  union all
  select 'column_privileges', jsonb_build_object(
    'table', c.relname, 'column', a.attname, 'acl', a.attacl
  ) from tables c join pg_attribute a on a.attrelid = c.oid
  where a.attnum > 0 and not a.attisdropped and a.attacl is not null
  union all
  select 'function_privileges', jsonb_build_object(
    'signature', p.oid::regprocedure::text, 'role', r.rolname,
    'execute', has_function_privilege(r.oid, p.oid, 'EXECUTE')
  ) from functions p cross join pg_roles r
  where r.rolname in ('anon', 'authenticated', 'service_role')
  union all
  select 'default_privileges', jsonb_build_object(
    'creator', pg_get_userbyid(d.defaclrole), 'schema', n.nspname,
    'object_type', d.defaclobjtype, 'acl', d.defaclacl
  ) from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
  where n.nspname = 'public' or d.defaclnamespace = 0
),
grouped as (
  select section, jsonb_agg(detail order by detail::text) as details
  from items group by section
)
select jsonb_build_object(
  'read_only', current_setting('transaction_read_only'),
  'observed_at', clock_timestamp(),
  'catalog', (select jsonb_object_agg(section, details) from grouped)
) as compatibility_result;

rollback;
