create table public.session_context_supplement_revisions (
  session_id uuid not null references public.sessions(id) on delete cascade,
  revision integer not null check (revision > 0),
  context_text text not null check (char_length(context_text) <= 1000),
  created_at timestamptz not null default now(),
  primary key (session_id, revision)
);

alter table public.session_context_supplement_revisions enable row level security;

create policy "participants read their session context supplements"
on public.session_context_supplement_revisions
for select to authenticated
using (
  exists (
    select 1
    from public.sessions s
    join public.profiles p on p.id = s.participant_id
    where s.id = session_context_supplement_revisions.session_id
      and s.participant_id = auth.uid()
      and p.role = 'participant'
      and p.status = 'active'
  )
);

revoke all on public.session_context_supplement_revisions from public, anon, authenticated, service_role;
grant select on public.session_context_supplement_revisions to authenticated;

create function public.save_session_context_supplement(
  p_session_id uuid,
  p_context_text text,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions%rowtype;
  v_profile public.profiles%rowtype;
  v_revision integer := 0;
  v_existing_text text := '';
  v_saved_revision integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_context_text is null
     or char_length(p_context_text) > 1000
     or p_expected_revision is null
     or p_expected_revision < 0 then
    raise exception 'Invalid session context supplement' using errcode = '22023';
  end if;

  select * into v_profile
  from public.profiles p
  where p.id = auth.uid()
  for share;

  if not found or v_profile.role <> 'participant' or v_profile.status <> 'active' then
    raise exception 'Active Participant required' using errcode = '42501';
  end if;

  select * into v_session
  from public.sessions s
  where s.id = p_session_id
    and s.participant_id = auth.uid()
  for update;

  if not found then
    raise exception 'Session not found' using errcode = '42501';
  end if;

  if v_session.status <> 'in_progress' then
    raise exception 'Session context is not editable' using errcode = '55000';
  end if;

  select r.revision, r.context_text into v_revision, v_existing_text
  from public.session_context_supplement_revisions r
  where r.session_id = p_session_id
  order by r.revision desc
  limit 1;

  v_revision := coalesce(v_revision, 0);
  v_existing_text := coalesce(v_existing_text, '');

  if v_revision <> p_expected_revision then
    raise exception 'Session context supplement changed' using errcode = '40001';
  end if;

  if v_existing_text = p_context_text then
    return jsonb_build_object('revision', v_revision, 'context_text', v_existing_text);
  end if;

  v_saved_revision := v_revision + 1;
  insert into public.session_context_supplement_revisions(session_id, revision, context_text)
  values (p_session_id, v_saved_revision, p_context_text);

  return jsonb_build_object('revision', v_saved_revision, 'context_text', p_context_text);
end;
$$;

revoke all on function public.save_session_context_supplement(uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.save_session_context_supplement(uuid, text, integer)
  to authenticated;
