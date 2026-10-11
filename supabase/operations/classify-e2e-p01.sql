-- NOT A MIGRATION. Prepared only; do not execute without separate approval.
-- First run account-type-preflight.sql and confirm the actual project separately.
-- After approval, use Auth Admin updateUserById for the exact target UUID:
-- { email: 't01@participants.whybox.invalid', email_confirm: true }
-- Omit password, role, metadata and every other attribute. Never UPDATE auth tables.
-- Verify UUID/password hash/authorization against a private pre-API baseline.
-- This transaction expects the verified Auth email change to have succeeded.
-- SET whybox.production_classification_approved = 'jaqyzbrvufknpsbcuqzw';
-- Default ROLLBACK rehearses ONLY the profile change; it cannot undo the Auth API.
-- On failure, stop and compensate the Auth email via the Admin API after review.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$
declare
  target_id constant uuid := 'ec0bba1e-3720-4200-a5e1-aed0673d2c32';
  admin_id constant uuid := '89507e34-b4fa-464a-b359-316be9a6bdcb';
  admin_before jsonb;
  target_before jsonb;
  other_profiles_before jsonb;
  auth_before jsonb;
  history_before bigint;
  affected bigint;
begin
  if current_setting('whybox.production_classification_approved', true)
    is distinct from 'jaqyzbrvufknpsbcuqzw' then
    raise exception 'Production classification approval and project confirmation required';
  end if;
  -- Prevent concurrent profile creation, renaming or classification during this short transaction.
  lock table public.profiles in share row exclusive mode;
  select to_jsonb(p) into admin_before from public.profiles p
    where id = admin_id and role = 'admin' and status = 'active'
      and participant_code is null and account_type is null;
  select to_jsonb(p) into target_before from public.profiles p
    where id = target_id and participant_code = 'P01'
      and role = 'participant' and status = 'active' and account_type is null;
  if admin_before is null or target_before is null then
    raise exception 'Protected admin or unclassified active E2E P01 identity differs; stop';
  end if;
  if not exists (
    select 1 from auth.users where id = target_id
      and email = 't01@participants.whybox.invalid' and email_confirmed_at is not null
  ) or not exists (select 1 from auth.users where id = admin_id) then
    raise exception 'Verified Auth Admin email transition must precede the profile change';
  end if;
  if exists (select 1 from public.profiles where id <> target_id
      and upper(participant_code) = 'T01')
    or exists (select 1 from auth.users where id <> target_id
      and lower(email) = 't01@participants.whybox.invalid')
    or exists (select 1 from auth.identities where user_id <> target_id
      and provider = 'email' and lower(identity_data->>'email') = 't01@participants.whybox.invalid') then
    raise exception 'T01 code or Auth identity already exists; stop';
  end if;
  select jsonb_agg(to_jsonb(p) order by p.id) into other_profiles_before
    from public.profiles p where id <> target_id;
  -- These snapshots remain inside PostgreSQL and are never SELECTed or logged.
  select jsonb_agg(to_jsonb(u) order by u.id) into auth_before from auth.users u;
  select count(*) into history_before from public.account_type_events where participant_id = target_id;
  perform set_config('whybox.account_type_reason', 'Approved E2E P01 to T01 rename; not a research participant', true);
  update public.profiles set participant_code = 'T01', account_type = 'T'
    where id = target_id and role = 'participant' and status = 'active'
      and participant_code = 'P01' and account_type is null;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'Expected exactly one E2E profile change'; end if;
  if admin_before is distinct from (select to_jsonb(p) from public.profiles p where id = admin_id)
    or other_profiles_before is distinct from (
      select jsonb_agg(to_jsonb(p) order by p.id) from public.profiles p where id <> target_id)
    or auth_before is distinct from (select jsonb_agg(to_jsonb(u) order by u.id) from auth.users u)
    or (target_before - 'participant_code' - 'account_type' - 'updated_at') is distinct from (
      select to_jsonb(p) - 'participant_code' - 'account_type' - 'updated_at'
        from public.profiles p where id = target_id)
    or not exists (select 1 from public.profiles
      where id = target_id and participant_code = 'T01' and account_type = 'T')
    or (select count(*) from public.account_type_events where participant_id = target_id) <> history_before + 1
    or not exists (select 1 from public.account_type_events
      where participant_id = target_id and previous_type is null and account_type = 'T'
        and reason = 'Approved E2E P01 to T01 rename; not a research participant') then
    raise exception 'Protected identity, target fields or audit verification failed';
  end if;
end;
$$;
-- Choose COMMIT only with separate execution approval and a reviewed baseline.
rollback;
