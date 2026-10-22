-- Read-only timestamp evidence, not proof of equality with a backup.
-- Set cutoff to the exact latest successful physical backup time in UTC.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '20s';
set local lock_timeout = '3s';

with settings as (
  select timestamptz '2026-10-21 15:04:44+00' as cutoff
),
records(table_name, row_data) as (
  select 'question_regeneration_requests', to_jsonb(t) from public.question_regeneration_requests t
  union all
  select 'question_regeneration_attempts', to_jsonb(t) from public.question_regeneration_attempts t
  union all
  select 'question_regeneration_candidates', to_jsonb(t) from public.question_regeneration_candidates t
  union all
  select 'question_regeneration_events', to_jsonb(t) from public.question_regeneration_events t
  union all
  select 'session_briefing_requests', to_jsonb(t) from public.session_briefing_requests t
  union all
  select 'session_briefing_sources', to_jsonb(t) from public.session_briefing_sources t
  union all
  select 'session_briefing_versions', to_jsonb(t) from public.session_briefing_versions t
  union all
  select 'session_diary_prompt_shown', to_jsonb(t) from public.session_diary_prompt_shown t
),
tables(table_name) as (values
  ('question_regeneration_requests'), ('question_regeneration_attempts'),
  ('question_regeneration_candidates'), ('question_regeneration_events'),
  ('session_briefing_requests'), ('session_briefing_sources'),
  ('session_briefing_versions'), ('session_diary_prompt_shown')
),
row_times as (
  select r.table_name, max(v.value::timestamptz) as latest_recorded_at
  from records r
  left join lateral jsonb_each_text(r.row_data) v on v.key in (
    'created_at', 'updated_at', 'reserved_at', 'dispatched_at',
    'finished_at', 'generated_at', 'staged_at',
    'dispatch_started_at', 'edited_at', 'shown_at'
  ) and v.value is not null
  group by r.table_name
),
counts as (
  select table_name, count(*) as rows from records group by table_name
)
select jsonb_build_object(
  'read_only', current_setting('transaction_read_only'),
  'backup_cutoff_utc', (select cutoff from settings),
  'tables', (
    select jsonb_agg(jsonb_build_object(
      'table', t.table_name, 'rows', coalesce(c.rows, 0),
      'latest_recorded_at', rt.latest_recorded_at,
      'recorded_change_after_backup',
        coalesce(rt.latest_recorded_at > (select cutoff from settings), false)
    ) order by t.table_name)
    from tables t left join counts c using (table_name)
    left join row_times rt using (table_name)
  ),
  'auth_users_timestamp_summary', (
    select jsonb_build_object(
      'users', count(*),
      'created_after_backup', count(*) filter (where created_at > s.cutoff),
      'updated_after_backup', count(*) filter (where updated_at > s.cutoff),
      'signed_in_after_backup', count(*) filter (where last_sign_in_at > s.cutoff),
      'latest_updated_at', max(updated_at),
      'latest_sign_in_at', max(last_sign_in_at)
    ) from auth.users cross join settings s
  )
) as backup_cutoff_result;

rollback;
