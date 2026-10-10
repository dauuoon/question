begin;

alter table public.profiles add column last_activity_at timestamptz;
revoke update (last_activity_at) on public.profiles from public, anon, authenticated;

create function public.record_participant_activity(p_participant_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  update public.profiles p
  set last_activity_at = v_now
  where p.id = p_participant_id
    and p.role = 'participant' and p.status = 'active'
    and (p.last_activity_at is null or p.last_activity_at < v_now - interval '5 minutes');
  return found;
end;
$$;

alter function public.record_participant_activity(uuid) owner to postgres;
revoke all on function public.record_participant_activity(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.record_participant_activity(uuid) to service_role;

notify pgrst, 'reload schema';
commit;
