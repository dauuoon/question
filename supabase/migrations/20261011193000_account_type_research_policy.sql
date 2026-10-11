begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Existing accounts stay unclassified until reviewed; never infer from their code.
alter table public.profiles add column account_type text;
alter table public.profiles add constraint profiles_account_type_check check (
  account_type is null or (role = 'participant' and account_type in ('P', 'T'))
);
alter table public.profiles drop constraint profiles_participant_code_format_check;
alter table public.profiles add constraint profiles_participant_code_format_check check (
  participant_code is null or participant_code ~ '^[PT][0-9]{2,}$'
);

create table public.account_type_events (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.profiles(id) on delete restrict,
  previous_type text check (previous_type in ('P', 'T')),
  account_type text not null check (account_type in ('P', 'T')),
  changed_by uuid references public.profiles(id) on delete restrict,
  reason text not null check (char_length(reason) between 1 and 500),
  changed_at timestamptz not null default clock_timestamp()
);
create index account_type_events_participant_time on public.account_type_events(participant_id, changed_at);
alter table public.account_type_events enable row level security;
revoke all on public.account_type_events from public, anon, authenticated, service_role;
grant select on public.account_type_events to authenticated, service_role;
create policy account_type_events_admin_read on public.account_type_events
for select to authenticated using ((select public.is_active_admin()));

create function public.record_account_type_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.account_type is not null and
    (tg_op = 'INSERT' or old.account_type is distinct from new.account_type) then
    insert into public.account_type_events(participant_id, previous_type, account_type, changed_by, reason)
    values(new.id, case when tg_op = 'INSERT' then null else old.account_type end, new.account_type,
      auth.uid(), coalesce(nullif(current_setting('whybox.account_type_reason', true), ''),
        case when tg_op = 'INSERT' then 'Account created with explicit type' else 'Database operator classification' end));
  elsif tg_op = 'UPDATE' and old.account_type is not null and new.account_type is null then
    raise exception 'ACCOUNT-TYPE-CLEAR: classified accounts cannot be silently cleared';
  end if;
  return new;
end;
$$;
revoke all on function public.record_account_type_event() from public, anon, authenticated, service_role;
create trigger profiles_account_type_event after insert or update of account_type on public.profiles
for each row execute function public.record_account_type_event();

create function public.guard_account_type_events()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'ACCOUNT-TYPE-HISTORY: classification history is immutable';
end;
$$;
revoke all on function public.guard_account_type_events() from public, anon, authenticated, service_role;
create trigger account_type_events_history before update or delete on public.account_type_events
for each row execute function public.guard_account_type_events();
create trigger account_type_events_no_truncate before truncate on public.account_type_events
for each statement execute function public.guard_account_type_events();

create function public.change_participant_account_type(
  p_participant_id uuid, p_expected_type text, p_account_type text, p_reason text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  target public.profiles%rowtype;
begin
  if not public.is_active_admin() then
    raise exception 'ACCOUNT-TYPE-DENIED: active administrator required';
  end if;
  if p_account_type is null or p_account_type not in ('P', 'T')
    or (p_expected_type is not null and p_expected_type not in ('P', 'T'))
    or p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    raise exception 'ACCOUNT-TYPE-INPUT: invalid classification';
  end if;
  select * into target from public.profiles where id = p_participant_id for update;
  if not found or target.role <> 'participant' then
    raise exception 'ACCOUNT-TYPE-TARGET: participant required';
  end if;
  if target.account_type is distinct from p_expected_type then
    raise exception 'ACCOUNT-TYPE-CONFLICT: reload the current classification';
  end if;
  if target.account_type = p_account_type then return false; end if;
  perform set_config('whybox.account_type_reason', btrim(p_reason), true);
  update public.profiles set account_type = p_account_type where id = p_participant_id;
  return true;
end;
$$;
revoke all on function public.change_participant_account_type(uuid,text,text,text)
from public, anon, authenticated, service_role;
grant execute on function public.change_participant_account_type(uuid,text,text,text) to authenticated;

-- Keep profiles read-only to ordinary clients; only the checked RPC changes type.
revoke update (account_type) on public.profiles from public, anon, authenticated;
commit;
