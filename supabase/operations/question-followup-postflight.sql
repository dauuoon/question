-- Run only after the approved migration commits. No application RPC is called.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '20s';
set local lock_timeout = '3s';

with expected_functions(signature) as (values
  ('public.begin_question_followup(uuid,uuid,uuid,uuid,timestamptz,text,text,text)'),
  ('public.dispatch_question_followup(uuid,text)'),
  ('public.finish_question_followup(uuid,text,text,text,integer,integer,text)')
),
expected_triggers(table_name, trigger_name) as (values
  ('answers', 'answers_02_followup_lock'),
  ('questions', 'questions_followup_lock'),
  ('question_action_requests', 'question_actions_followup_lock'),
  ('question_regeneration_requests', 'question_regeneration_followup_lock'),
  ('question_followup_requests', 'question_followup_requests_history')
)
select jsonb_build_object(
  'read_only', current_setting('transaction_read_only'),
  'observed_at', clock_timestamp(),
  'ledger', (
    select jsonb_build_object(
      'owner', pg_get_userbyid(c.relowner), 'rls', c.relrowsecurity,
      'rows', (select count(*) from public.question_followup_requests)
    )
    from pg_class c where c.oid = 'public.question_followup_requests'::regclass
  ),
  'ledger_privileges', (
    select jsonb_agg(jsonb_build_object(
      'role', r.rolname,
      'select', has_table_privilege(r.oid, 'public.question_followup_requests', 'SELECT'),
      'insert', has_table_privilege(r.oid, 'public.question_followup_requests', 'INSERT'),
      'update', has_table_privilege(r.oid, 'public.question_followup_requests', 'UPDATE'),
      'delete', has_table_privilege(r.oid, 'public.question_followup_requests', 'DELETE'),
      'truncate', has_table_privilege(r.oid, 'public.question_followup_requests', 'TRUNCATE')
    ) order by r.rolname)
    from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
  ),
  'rpc_privileges', (
    select jsonb_agg(jsonb_build_object(
      'signature', e.signature, 'present', p.oid is not null,
      'owner', pg_get_userbyid(p.proowner), 'security_definer', p.prosecdef,
      'config', p.proconfig, 'role', r.rolname,
      'execute', has_function_privilege(r.oid, p.oid, 'EXECUTE')
    ) order by e.signature, r.rolname)
    from expected_functions e
    left join pg_proc p on p.oid = to_regprocedure(e.signature)
    cross join pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
  ),
  'triggers', (
    select jsonb_agg(jsonb_build_object(
      'table', e.table_name, 'name', e.trigger_name,
      'present', t.oid is not null, 'enabled', t.tgenabled
    ) order by e.table_name, e.trigger_name)
    from expected_triggers e left join pg_trigger t
      on t.tgrelid = to_regclass('public.' || e.table_name)
      and t.tgname = e.trigger_name and not t.tgisinternal
  ),
  'indexes', (
    select jsonb_agg(jsonb_build_object(
      'name', c.relname, 'valid', i.indisvalid, 'ready', i.indisready,
      'definition', pg_get_indexdef(i.indexrelid)
    ) order by c.relname)
    from pg_index i join pg_class c on c.oid = i.indexrelid
    where i.indrelid = 'public.question_followup_requests'::regclass
  ),
  'policies', (
    select jsonb_agg(to_jsonb(p) order by p.policyname)
    from pg_policies p where p.schemaname = 'public'
      and p.tablename = 'question_followup_requests'
  ),
  'row_counts', jsonb_build_object(
    'profiles', (select count(*) from public.profiles),
    'sessions', (select count(*) from public.sessions),
    'session_contexts', (select count(*) from public.session_contexts),
    'session_images', (select count(*) from public.session_images),
    'questions', (select count(*) from public.questions),
    'question_targets', (select count(*) from public.question_targets),
    'answers', (select count(*) from public.answers),
    'question_events', (select count(*) from public.question_events),
    'diaries', (select count(*) from public.diaries)
  ),
  't01', (
    select jsonb_agg(jsonb_build_object(
      'id', id, 'code', participant_code, 'account_type', account_type,
      'role', role, 'status', status
    ))
    from public.profiles where upper(participant_code) = 'T01'
  )
) as postflight_result;

rollback;
