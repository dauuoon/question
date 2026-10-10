-- Pause uploads and deploy the reservation-aware API before reopening uploads.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

lock table public.profiles in share mode;
lock table public.sessions, public.session_images in share row exclusive mode;
lock table storage.objects in share row exclusive mode;

create table public.storage_upload_slots (
  session_id uuid not null references public.sessions (id) on delete restrict,
  slot_index smallint not null check (slot_index between 1 and 10),
  request_id uuid not null,
  storage_path text not null unique,
  sort_order integer not null check (sort_order >= 0),
  created_at timestamptz not null default now(),
  primary key (session_id, slot_index),
  unique (session_id, request_id),
  unique (session_id, sort_order)
);

alter table public.storage_upload_slots enable row level security;
revoke all on public.storage_upload_slots from public, anon, authenticated, service_role;

create temporary table why_box_upload_backfill on commit drop as
select distinct paths.storage_path
from (
  select o.name as storage_path
  from storage.objects o where o.bucket_id = 'why-box-images'
  union
  select i.storage_path from public.session_images i
) paths;

do $$
begin
  if exists (
    select 1
    from why_box_upload_backfill b
    left join public.sessions s on s.id::text = split_part(b.storage_path, '/', 2)
    left join public.profiles p on p.id = s.participant_id
    where s.id is null
      or p.role is distinct from 'participant'
      or split_part(b.storage_path, '/', 1) <> s.participant_id::text
      or array_length(string_to_array(b.storage_path, '/'), 1) <> 3
      or split_part(b.storage_path, '/', 3) !~* '^[^/]+[.](jpg|jpeg|png)$'
  ) then
    raise exception 'WHY BOX backfill aborted: invalid participant/session object path';
  end if;

  if exists (
    select 1
    from why_box_upload_backfill b
    group by split_part(b.storage_path, '/', 2)
    having count(*) > 10
  ) then
    raise exception 'WHY BOX backfill aborted: session has more than ten distinct paths';
  end if;

  -- Fail closed on orphan objects or metadata without an object; never delete either.
  if exists (
    select 1
    from why_box_upload_backfill b
    left join storage.objects o
      on o.bucket_id = 'why-box-images' and o.name = b.storage_path
    left join public.session_images i on i.storage_path = b.storage_path
    where o.id is null or i.id is null
      or i.session_id::text <> split_part(b.storage_path, '/', 2)
  ) then
    raise exception 'WHY BOX backfill aborted: Storage and image metadata are not one-to-one';
  end if;

  if exists (
    select 1
    from public.session_images i
    join storage.objects o
      on o.bucket_id = 'why-box-images' and o.name = i.storage_path
    where o.metadata ->> 'mimetype' is distinct from i.mime_type
      or case
        when o.metadata ->> 'size' ~ '^[0-9]{1,8}$'
          then (o.metadata ->> 'size')::bigint <> i.file_size
        else true
      end
  ) then
    raise exception 'WHY BOX backfill aborted: object MIME/size differs from image metadata';
  end if;
end;
$$;

insert into public.storage_upload_slots (
  session_id, slot_index, request_id, storage_path, sort_order
)
select
  i.session_id,
  (row_number() over (
    partition by i.session_id order by i.sort_order, i.storage_path
  ))::smallint,
  gen_random_uuid(),
  i.storage_path,
  i.sort_order
from public.session_images i
join why_box_upload_backfill b on b.storage_path = i.storage_path;

create function public.guard_storage_upload_slot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Upload reservations are immutable and cannot be released';
  end if;
  if not exists (
    select 1
    from public.sessions s
    join public.profiles p on p.id = s.participant_id
    where s.id = new.session_id
      and p.role = 'participant'
      and split_part(new.storage_path, '/', 1) = s.participant_id::text
      and split_part(new.storage_path, '/', 2) = s.id::text
      and array_length(string_to_array(new.storage_path, '/'), 1) = 3
      and split_part(new.storage_path, '/', 3) ~* '^[^/]+[.](jpg|jpeg|png)$'
  ) then
    raise exception 'Invalid upload reservation path';
  end if;
  return new;
end;
$$;

create trigger storage_upload_slots_immutable
before insert or update or delete on public.storage_upload_slots
for each row execute function public.guard_storage_upload_slot();

create trigger storage_upload_slots_no_truncate
before truncate on public.storage_upload_slots
for each statement execute function public.guard_storage_upload_slot();

create function public.reserve_image_upload(
  p_session_id uuid,
  p_request_id uuid,
  p_extension text,
  p_content_sha256 text
)
returns table (storage_path text, slot_index smallint, sort_order integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_participant_id uuid;
  v_path text;
  v_existing public.storage_upload_slots%rowtype;
  v_slot smallint;
  v_sort_order integer;
begin
  if auth.uid() is null or p_session_id is null or p_request_id is null
    or p_extension is null or p_extension not in ('jpg', 'png')
    or p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid upload reservation input';
  end if;

  select s.participant_id into v_participant_id
  from public.sessions s
  join public.profiles p on p.id = s.participant_id
  where s.id = p_session_id and s.participant_id = auth.uid()
    and p.role = 'participant' and p.status = 'active'
    and s.status in ('draft', 'question_generation')
  for update of s;

  if v_participant_id is null or exists (
    select 1 from public.questions q where q.session_id = p_session_id
  ) then
    raise exception using errcode = '42501', message = 'Upload reservation denied';
  end if;

  v_path := v_participant_id::text || '/' || p_session_id::text || '/' ||
    p_request_id::text || '-' || p_content_sha256 || '.' || p_extension;

  select u.* into v_existing
  from public.storage_upload_slots u
  where u.session_id = p_session_id and u.request_id = p_request_id;

  if found then
    if v_existing.storage_path <> v_path then
      raise exception using errcode = '22023', message = 'Upload request content mismatch';
    end if;
    return query select v_existing.storage_path, v_existing.slot_index, v_existing.sort_order;
    return;
  end if;

  select coalesce(max(u.sort_order), -1) + 1 into v_sort_order
  from public.storage_upload_slots u where u.session_id = p_session_id;
  select greatest(v_sort_order, coalesce(max(i.sort_order), -1) + 1) into v_sort_order
  from public.session_images i where i.session_id = p_session_id;

  for v_slot in 1..10 loop
    insert into public.storage_upload_slots as u (
      session_id, slot_index, request_id, storage_path, sort_order
    )
    values (p_session_id, v_slot, p_request_id, v_path, v_sort_order)
    on conflict on constraint storage_upload_slots_pkey do nothing;
    if found then
      return query select v_path, v_slot::smallint, v_sort_order;
      return;
    end if;
  end loop;

  raise exception using errcode = '23514', message = 'Session upload capacity exhausted';
end;
$$;

create function public.is_reserved_image_path(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.storage_upload_slots u
    join public.sessions s on s.id = u.session_id
    join public.profiles p on p.id = s.participant_id
    where u.storage_path = p_name
      and s.participant_id = auth.uid()
      and p.role = 'participant' and p.status = 'active'
  );
$$;

alter table public.storage_upload_slots owner to postgres;
alter function public.guard_storage_upload_slot() owner to postgres;
alter function public.reserve_image_upload(uuid, uuid, text, text) owner to postgres;
alter function public.is_reserved_image_path(text) owner to postgres;

revoke all on function public.guard_storage_upload_slot() from public, anon, authenticated, service_role;
revoke all on function public.reserve_image_upload(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.is_reserved_image_path(text) from public, anon, authenticated, service_role;
grant execute on function public.reserve_image_upload(uuid, uuid, text, text) to authenticated;
grant execute on function public.is_reserved_image_path(text) to authenticated;

create policy why_box_images_reserved_insert
on storage.objects as restrictive
for insert to authenticated
with check (
  bucket_id <> 'why-box-images' or public.is_reserved_image_path(name)
);

create policy why_box_images_reserved_update
on storage.objects as restrictive
for update to authenticated
using (true)
with check (
  bucket_id <> 'why-box-images' or public.is_reserved_image_path(name)
);

notify pgrst, 'reload schema';
commit;
