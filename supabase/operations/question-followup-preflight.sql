-- Run manually in the intended Supabase project's SQL Editor.
-- Catalog inspection only: no application RPCs, DDL, DML or role changes.
-- Missing objects are reported rather than dereferenced.
-- Keep every statement, including BEGIN and ROLLBACK, in the execution.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '20s';
set local lock_timeout = '3s';

-- 01: Execution context. Verify the project ref separately in the Dashboard.
select '01_context' as section, current_database() as database_name,
  current_user as executing_role,
  current_setting('transaction_read_only') as read_only,
  current_setting('transaction_isolation') as isolation,
  clock_timestamp() as observed_at,
  to_regclass('supabase_migrations.schema_migrations') as history_table;

-- 02: Required existing tables and objects introduced by the new migration.
with expected(name, purpose) as (values
  ('profiles', 'existing'), ('sessions', 'existing'),
  ('questions', 'existing'), ('answers', 'existing'),
  ('question_targets', 'existing'), ('question_events', 'existing'),
  ('question_action_requests', 'existing'),
  ('question_regeneration_requests', 'existing'),
  ('question_regeneration_attempts', 'existing'),
  ('question_regeneration_candidates', 'existing'),
  ('question_regeneration_events', 'existing'),
  ('question_followup_requests', 'new')
)
select '02_tables' as section, e.name, e.purpose,
  c.oid is not null as present, c.relkind,
  pg_get_userbyid(c.relowner) as owner,
  c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
  c.relacl::text as explicit_acl
from expected e
left join pg_namespace n on n.nspname = 'public'
left join pg_class c on c.relnamespace = n.oid and c.relname = e.name
order by e.purpose, e.name;

-- 03: All columns of the tables directly used by the follow-up SQL/API.
select '03_columns' as section, c.relname as table_name, a.attnum,
  a.attname as column_name, format_type(a.atttypid, a.atttypmod) as data_type,
  a.attnotnull as not_null, a.attidentity as identity_kind,
  a.attgenerated as generated_kind,
  pg_get_expr(d.adbin, d.adrelid) as default_expression
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where n.nspname = 'public' and c.relname in (
  'profiles', 'sessions', 'questions', 'answers', 'question_targets',
  'question_events', 'question_action_requests',
  'question_regeneration_requests', 'question_followup_requests'
) and a.attnum > 0 and not a.attisdropped
order by c.relname, a.attnum;

-- 04: CHECK/UNIQUE/FK rules, including FK delete behavior and validation.
select '04_constraints' as section, c.relname as table_name, k.conname,
  k.contype, k.convalidated, k.condeferrable, k.condeferred,
  pg_get_constraintdef(k.oid, true) as definition
from pg_constraint k
join pg_class c on c.oid = k.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in (
  'profiles', 'sessions', 'questions', 'answers', 'question_targets',
  'question_events', 'question_action_requests',
  'question_regeneration_requests', 'question_followup_requests'
)
order by c.relname, k.conname;

-- 05: Existing indexes and validity; new migration names must not collide.
select '05_indexes' as section, c.relname as table_name, idx.relname as index_name,
  i.indisunique, i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) as definition
from pg_index i
join pg_class c on c.oid = i.indrelid
join pg_class idx on idx.oid = i.indexrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and (
  c.relname in ('profiles', 'sessions', 'questions', 'answers',
    'question_targets', 'question_action_requests', 'question_regeneration_requests',
    'question_followup_requests')
  or idx.relname in ('question_followup_one_pending_per_root',
    'question_followup_one_success_per_root', 'question_followup_answer_outcome_unique')
)
order by c.relname, idx.relname;

-- 06: Non-internal triggers, their execution mode and function body.
-- O = enabled in normal origin mode; D = disabled; A = always; R = replica.
select '06_triggers' as section, c.relname as table_name, t.tgname,
  t.tgenabled, pg_get_triggerdef(t.oid, true) as trigger_definition,
  p.oid::regprocedure::text as function_signature,
  p.prosecdef as security_definer, p.proconfig,
  pg_get_userbyid(p.proowner) as function_owner,
  pg_get_functiondef(p.oid) as function_definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
where n.nspname = 'public' and not t.tgisinternal and c.relname in (
  'sessions', 'questions', 'answers', 'question_targets', 'question_events',
  'question_action_requests', 'question_regeneration_requests',
  'question_regeneration_attempts', 'question_regeneration_candidates',
  'question_regeneration_events', 'question_followup_requests'
)
order by c.relname, t.tgname;

-- 07: Exact helper/new RPC signatures. Existing helper definitions are included.
with expected(signature, purpose) as (values
  ('auth.role()', 'existing'),
  ('public.is_active_admin()', 'existing'),
  ('public.owns_session(uuid)', 'existing'),
  ('public.read_question_action_capabilities(uuid)', 'existing'),
  ('public.guard_question_followup_history()', 'new'),
  ('public.guard_question_followup_answer_lock()', 'new'),
  ('public.guard_question_followup_question_lock()', 'new'),
  ('public.guard_question_followup_conflicting_action()', 'new'),
  ('public.begin_question_followup(uuid,uuid,uuid,uuid,timestamptz,text,text,text)', 'new'),
  ('public.dispatch_question_followup(uuid,text)', 'new'),
  ('public.finish_question_followup(uuid,text,text,text,integer,integer,text)', 'new')
)
select '07_functions' as section, e.signature, e.purpose,
  p.oid is not null as present, pg_get_userbyid(p.proowner) as owner,
  p.prosecdef as security_definer, p.proconfig, p.proacl::text as explicit_acl,
  pg_get_functiondef(p.oid) as definition
from expected e
left join pg_proc p on p.oid = to_regprocedure(e.signature)
order by e.purpose, e.signature;

-- 08: All overloads with new names. Any existing overload needs review.
select '08_new_name_collisions' as section, p.oid::regprocedure::text as signature
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in (
  'guard_question_followup_history', 'guard_question_followup_answer_lock',
  'guard_question_followup_question_lock', 'guard_question_followup_conflicting_action',
  'begin_question_followup', 'dispatch_question_followup', 'finish_question_followup'
)
order by signature;

-- 09: RLS policy expressions. RLS flags are in section 02.
select '09_policies' as section, schemaname, tablename, policyname,
  permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in (
  'profiles', 'sessions', 'questions', 'answers', 'question_targets',
  'question_events', 'question_action_requests', 'question_regeneration_requests',
  'question_regeneration_attempts', 'question_regeneration_candidates',
  'question_regeneration_events', 'question_followup_requests'
)
order by tablename, policyname;

-- 10: Effective table/schema privileges, including inherited/PUBLIC grants.
-- Table privileges do not by themselves imply RLS permits access.
select '10_effective_table_grants' as section, r.rolname, c.relname as table_name,
  r.rolsuper, r.rolbypassrls,
  has_schema_privilege(r.oid, n.oid, 'USAGE') as schema_usage,
  has_table_privilege(r.oid, c.oid, 'SELECT') as can_select,
  has_table_privilege(r.oid, c.oid, 'INSERT') as can_insert,
  has_table_privilege(r.oid, c.oid, 'UPDATE') as can_update,
  has_table_privilege(r.oid, c.oid, 'DELETE') as can_delete,
  has_table_privilege(r.oid, c.oid, 'TRUNCATE') as can_truncate
from pg_roles r cross join pg_class c
join pg_namespace n on n.oid = c.relnamespace
where r.rolname in ('anon', 'authenticated', 'service_role')
  and n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname in (
    'profiles', 'sessions', 'questions', 'answers', 'question_targets',
    'question_events', 'question_action_requests', 'question_regeneration_requests',
    'question_regeneration_attempts', 'question_regeneration_candidates',
    'question_regeneration_events', 'question_followup_requests'
  )
order by c.relname, r.rolname;

-- 11: Column-level privileges can exist without table-level DML privileges.
select '11_explicit_column_grants' as section, c.relname as table_name,
  a.attname as column_name,
  case when acl.grantee = 0 then 'PUBLIC'
    else pg_get_userbyid(acl.grantee) end as grantee,
  acl.privilege_type, acl.is_grantable
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(a.attacl) acl
where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped
  and c.relname in ('profiles', 'sessions', 'questions', 'answers',
    'question_targets', 'question_events', 'question_action_requests',
    'question_regeneration_requests', 'question_followup_requests')
order by c.relname, a.attname, grantee, acl.privilege_type;

-- 12: Effective EXECUTE privileges; no functions are invoked here.
select '12_effective_function_grants' as section,
  p.oid::regprocedure::text as signature, r.rolname,
  has_function_privilege(r.oid, p.oid, 'EXECUTE') as can_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
cross join pg_roles r
where n.nspname = 'public' and r.rolname in ('anon', 'authenticated', 'service_role')
  and p.proname in (
    'is_active_admin', 'owns_session', 'read_question_action_capabilities',
    'guard_question_followup_history', 'guard_question_followup_answer_lock',
    'guard_question_followup_question_lock', 'guard_question_followup_conflicting_action',
    'begin_question_followup', 'dispatch_question_followup', 'finish_question_followup'
  )
order by signature, r.rolname;

-- 13: Default grants are informational, not a substitute for explicit new grants.
select '13_default_grants' as section, pg_get_userbyid(d.defaclrole) as creator_role,
  n.nspname as schema_name, d.defaclobjtype, d.defaclacl::text as default_acl
from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
where n.nspname = 'public' or d.defaclnamespace = 0
order by creator_role, schema_name, d.defaclobjtype;

-- 14: Incoming foreign keys document existing account/session deletion limits.
select '14_incoming_foreign_keys' as section,
  k.conrelid::regclass::text as referencing_table, k.conname,
  k.confrelid::regclass::text as referenced_table,
  pg_get_constraintdef(k.oid, true) as definition
from pg_constraint k
where k.contype = 'f' and k.confrelid in (
  to_regclass('public.profiles'), to_regclass('public.sessions'),
  to_regclass('public.questions'), to_regclass('auth.users')
)
order by referenced_table, referencing_table, k.conname;

rollback;
