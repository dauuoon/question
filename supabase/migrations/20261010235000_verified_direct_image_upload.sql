-- Local-only. Coordinate this migration with the direct-upload client/server release.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- Prevent bypassing server byte verification through the public REST table API.
revoke insert, update on public.session_images from authenticated, anon;

-- Keep reserved object bytes immutable between verification and metadata commit.
create policy why_box_images_no_overwrite on storage.objects as restrictive
for update to authenticated
using (bucket_id <> 'why-box-images')
with check (bucket_id <> 'why-box-images');

create function public.read_direct_image_upload_capability()
returns integer language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null or not exists (
    select 1 from public.profiles p where p.id = auth.uid()
      and p.role = 'participant' and p.status = 'active'
  ) then
    raise exception 'Active participant required' using errcode = '42501';
  end if;
  return 1;
end;
$$;
alter function public.read_direct_image_upload_capability() owner to postgres;
revoke all on function public.read_direct_image_upload_capability() from public, anon, authenticated, service_role;
grant execute on function public.read_direct_image_upload_capability() to authenticated;

create function public.finish_verified_image_upload(
  p_session_id uuid, p_request_id uuid, p_participant_id uuid,
  p_content_sha256 text, p_mime_type text, p_file_size integer,
  p_original_filename text, p_width integer, p_height integer
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  s public.sessions%rowtype;
  u public.storage_upload_slots%rowtype;
  i public.session_images%rowtype;
  object_metadata jsonb;
  expected_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted verifier required' using errcode = '42501';
  end if;
  if p_session_id is null or p_request_id is null or p_participant_id is null
    or p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$'
    or p_mime_type is null or p_mime_type not in ('image/jpeg', 'image/png')
    or p_file_size is null or p_file_size not between 1 and 10485760
    or p_width is null or p_width < 1 or p_height is null or p_height < 1
    or p_original_filename is null or length(p_original_filename) not between 1 and 255
    or (p_mime_type = 'image/png' and p_original_filename !~* '[.]png$')
    or (p_mime_type = 'image/jpeg' and p_original_filename !~* '[.]jpe?g$') then
    raise exception 'Invalid verified image metadata' using errcode = '22023';
  end if;
  select * into s from public.sessions where id = p_session_id for update;
  if not found or s.participant_id <> p_participant_id or s.status not in ('draft', 'question_generation') then
    raise exception 'Editable ownership required' using errcode = '42501';
  end if;
  perform 1 from public.profiles p where p.id = p_participant_id
    and p.role = 'participant' and p.status = 'active' for share;
  if not found or exists (select 1 from public.questions q where q.session_id = p_session_id)
    or public.question_generation_has_running(p_session_id)
    or exists (select 1 from public.image_deletions d where d.session_id = p_session_id and (
      d.completed_at is null or d.image_id = p_request_id or d.request_id = p_request_id
    )) then
    raise exception 'Upload is frozen or deleted' using errcode = '42501';
  end if;
  expected_path := p_participant_id::text || '/' || p_session_id::text || '/' ||
    p_request_id::text || '-' || p_content_sha256 ||
    case when p_mime_type = 'image/jpeg' then '.jpg' else '.png' end;
  select * into u from public.storage_upload_slots
    where session_id = p_session_id and request_id = p_request_id;
  if not found or u.storage_path <> expected_path then
    raise exception 'Verified image reservation mismatch' using errcode = '22023';
  end if;
  select o.metadata into object_metadata from storage.objects o
    where o.bucket_id = 'why-box-images' and o.name = u.storage_path for share;
  if not found or object_metadata->>'mimetype' is distinct from p_mime_type
    or object_metadata->>'size' is distinct from p_file_size::text then
    raise exception 'Verified object metadata mismatch' using errcode = '22023';
  end if;
  select * into i from public.session_images where id = p_request_id;
  if found then
    if i.session_id <> p_session_id or i.storage_path <> u.storage_path or i.sort_order <> u.sort_order
      or i.mime_type <> p_mime_type or i.file_size <> p_file_size
      or i.width is distinct from p_width or i.height is distinct from p_height
      or i.original_filename <> p_original_filename then
      raise exception 'Verified metadata replay mismatch' using errcode = '22023';
    end if;
    return false;
  end if;
  insert into public.session_images(id, session_id, storage_path, original_filename,
    mime_type, file_size, width, height, sort_order)
  values (p_request_id, p_session_id, u.storage_path, p_original_filename,
    p_mime_type, p_file_size, p_width, p_height, u.sort_order);
  return true;
end;
$$;
alter function public.finish_verified_image_upload(uuid, uuid, uuid, text, text, integer, text, integer, integer)
  owner to postgres;
revoke all on function public.finish_verified_image_upload(uuid, uuid, uuid, text, text, integer, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_verified_image_upload(uuid, uuid, uuid, text, text, integer, text, integer, integer)
  to service_role;
notify pgrst, 'reload schema';
commit;
