-- Local only. Deploy deletion-aware API/UI together after remote verification.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';
lock table public.sessions, public.session_images, public.storage_upload_slots in share row exclusive mode;
lock table storage.objects in share row exclusive mode;

-- Completed rows are tombstones: a deleted upload request must never resurrect.
create table public.image_deletions (
  image_id uuid primary key,
  session_id uuid not null references public.sessions(id) on delete restrict,
  request_id uuid not null,
  storage_path text not null unique,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (session_id, request_id)
);
alter table public.image_deletions enable row level security;
revoke all on public.image_deletions from public, anon, authenticated, service_role;
grant select on public.image_deletions to authenticated;
create policy image_deletions_select_owner on public.image_deletions for select to authenticated
using (public.owns_session(session_id));

create function public.begin_image_deletion(p_session_id uuid, p_image_id uuid)
returns table(storage_path text, completed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_image public.session_images%rowtype;
  v_slot public.storage_upload_slots%rowtype;
  v_job public.image_deletions%rowtype;
begin
  if auth.uid() is null or p_session_id is null or p_image_id is null then
    raise exception using errcode = '22023', message = 'Invalid image deletion input';
  end if;
  perform 1 from public.sessions s join public.profiles p on p.id = s.participant_id
  where s.id = p_session_id and s.participant_id = auth.uid()
    and p.role = 'participant' and p.status = 'active'
    and s.status in ('draft', 'question_generation') for update of s;
  if not found or exists (select 1 from public.questions q where q.session_id = p_session_id) then
    raise exception using errcode = '42501', message = 'Image deletion denied';
  end if;
  select d.* into v_job from public.image_deletions d
    where d.image_id = p_image_id and d.session_id = p_session_id;
  if found then
    return query select v_job.storage_path, v_job.completed_at is not null;
    return;
  end if;
  select i.* into v_image from public.session_images i
    where i.id = p_image_id and i.session_id = p_session_id;
  if not found then
    raise exception using errcode = '22023', message = 'Image not registered';
  end if;
  select u.* into v_slot from public.storage_upload_slots u
    where u.session_id = p_session_id and u.storage_path = v_image.storage_path;
  if not found then
    raise exception using errcode = '23514', message = 'Image reservation missing';
  end if;
  insert into public.image_deletions(image_id, session_id, request_id, storage_path)
    values (p_image_id, p_session_id, v_slot.request_id, v_image.storage_path);
  return query select v_image.storage_path, false;
end;
$$;

create function public.finish_image_deletion(p_session_id uuid, p_image_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_job public.image_deletions%rowtype;
begin
  perform 1 from public.sessions s join public.profiles p on p.id = s.participant_id
  where s.id = p_session_id and s.participant_id = auth.uid()
    and p.role = 'participant' and p.status = 'active'
    and s.status in ('draft', 'question_generation') for update of s;
  if not found or exists (select 1 from public.questions q where q.session_id = p_session_id) then
    raise exception using errcode = '42501', message = 'Image deletion denied';
  end if;
  select d.* into v_job from public.image_deletions d
    where d.image_id = p_image_id and d.session_id = p_session_id;
  if not found then
    raise exception using errcode = '22023', message = 'Image deletion not started';
  end if;
  if v_job.completed_at is not null then return false; end if;
  if exists (select 1 from storage.objects o
    where o.bucket_id = 'why-box-images' and o.name = v_job.storage_path) then
    raise exception using errcode = '23514', message = 'Storage deletion not confirmed';
  end if;
  delete from public.session_images i where i.id = p_image_id and i.session_id = p_session_id;
  delete from public.storage_upload_slots u
    where u.session_id = p_session_id and u.storage_path = v_job.storage_path;
  update public.image_deletions set completed_at = now() where image_id = p_image_id;
  update public.sessions set updated_at = now() where id = p_session_id;
  return true;
end;
$$;

create or replace function public.guard_storage_upload_slot()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_user = 'postgres' and exists (
    select 1 from public.image_deletions d where d.storage_path = old.storage_path
      and d.session_id = old.session_id and d.completed_at is null
  ) and not exists (select 1 from storage.objects o
    where o.bucket_id = 'why-box-images' and o.name = old.storage_path)
    and not exists (select 1 from public.session_images i where i.storage_path = old.storage_path) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'Upload reservations can only be released by confirmed image deletion';
  end if;
  if exists (select 1 from public.image_deletions d
    where d.image_id = new.request_id or (d.session_id = new.session_id and
      (d.request_id = new.request_id or d.completed_at is null))) then
    raise exception using errcode = '22023', message = 'Deleted request or pending image deletion';
  end if;
  if not exists (
    select 1 from public.sessions s join public.profiles p on p.id = s.participant_id
    where s.id = new.session_id and p.role = 'participant'
      and split_part(new.storage_path, '/', 1) = s.participant_id::text
      and split_part(new.storage_path, '/', 2) = s.id::text
      and array_length(string_to_array(new.storage_path, '/'), 1) = 3
      and split_part(new.storage_path, '/', 3) ~* '^[^/]+[.](jpg|jpeg|png)$'
  ) then raise exception 'Invalid upload reservation path'; end if;
  return new;
end;
$$;

-- Serialize object writes with deletion claims. No lock spans the HTTP Storage call.
create or replace function public.is_reserved_image_path(p_name text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_session uuid;
begin
  select s.id into v_session from public.storage_upload_slots u
    join public.sessions s on s.id = u.session_id join public.profiles p on p.id = s.participant_id
    where u.storage_path = p_name and s.participant_id = auth.uid()
      and p.role = 'participant' and p.status = 'active' for update of s;
  if not found then return false; end if;
  return not exists (select 1 from public.image_deletions d where d.storage_path = p_name);
end;
$$;

create function public.is_pending_image_deletion(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.image_deletions d
    join public.sessions s on s.id = d.session_id join public.profiles p on p.id = s.participant_id
    where d.storage_path = p_name and d.completed_at is null and s.participant_id = auth.uid()
      and p.role = 'participant' and p.status = 'active');
$$;
create policy why_box_images_claimed_delete on storage.objects as restrictive
for delete to authenticated using (
  bucket_id <> 'why-box-images' or public.is_pending_image_deletion(name)
);
drop policy why_box_images_reserved_update on storage.objects;
create policy why_box_images_reserved_update on storage.objects as restrictive
for update to authenticated using (
  bucket_id <> 'why-box-images' or public.is_reserved_image_path(name)
) with check (
  bucket_id <> 'why-box-images' or public.is_reserved_image_path(name)
);

create function public.guard_image_deletion_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_session uuid;
begin
  if tg_op = 'DELETE' then v_session := old.session_id; else v_session := new.session_id; end if;
  perform 1 from public.sessions s where s.id = v_session for update;
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.image_deletions d where d.image_id = old.id
      and d.session_id = old.session_id and d.completed_at is null)
      or exists (select 1 from storage.objects o
        where o.bucket_id = 'why-box-images' and o.name = old.storage_path) then
      raise exception using errcode = '42501', message = 'Image deletion must finish through Storage';
    end if;
    return old;
  end if;
  if exists (select 1 from public.image_deletions d
    where d.image_id = new.id or d.storage_path = new.storage_path) then
    raise exception using errcode = '42501', message = 'Deleting image cannot be rewritten';
  end if;
  return new;
end;
$$;
create trigger session_images_deletion_guard before insert or update or delete on public.session_images
for each row execute function public.guard_image_deletion_write();

create function public.guard_pending_image_deletion()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_session uuid;
begin
  if tg_table_name = 'sessions' then
    if new.status is not distinct from old.status then return new; end if;
    v_session := new.id;
  else v_session := new.session_id; end if;
  perform 1 from public.sessions s where s.id = v_session for update;
  if exists (select 1 from public.image_deletions d
    where d.session_id = v_session and d.completed_at is null) then
    raise exception using errcode = '42501', message = 'Pending image deletion must be resolved first';
  end if;
  return new;
end;
$$;
create trigger questions_image_deletion_guard before insert or update on public.questions
for each row execute function public.guard_pending_image_deletion();
create trigger sessions_image_deletion_guard before update of status on public.sessions
for each row execute function public.guard_pending_image_deletion();

alter table public.image_deletions owner to postgres;
alter function public.begin_image_deletion(uuid, uuid) owner to postgres;
alter function public.finish_image_deletion(uuid, uuid) owner to postgres;
alter function public.guard_image_deletion_write() owner to postgres;
alter function public.guard_pending_image_deletion() owner to postgres;
alter function public.is_pending_image_deletion(text) owner to postgres;
revoke all on function public.begin_image_deletion(uuid, uuid), public.finish_image_deletion(uuid, uuid),
  public.guard_image_deletion_write(), public.guard_pending_image_deletion(),
  public.is_pending_image_deletion(text) from public, anon, authenticated, service_role;
grant execute on function public.begin_image_deletion(uuid, uuid), public.finish_image_deletion(uuid, uuid),
  public.is_pending_image_deletion(text) to authenticated;
notify pgrst, 'reload schema';
commit;
