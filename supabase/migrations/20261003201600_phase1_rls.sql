create function public.is_active_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
      and p.status = 'active'
  );
$$;

create function public.owns_session(target_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.sessions s
    join public.profiles p on p.id = s.participant_id
    where s.id = target_session_id
      and s.participant_id = (select auth.uid())
      and p.status = 'active'
      and p.role = 'participant'
  );
$$;

create function public.can_edit_session(target_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.sessions s
    join public.profiles p on p.id = s.participant_id
    where s.id = target_session_id
      and s.participant_id = (select auth.uid())
      and p.status = 'active'
      and p.role = 'participant'
      and s.status <> 'completed'
  );
$$;

create function public.can_edit_session_context(target_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.sessions s
    where s.id = target_session_id
      and s.participant_id = (select auth.uid())
      and exists (
        select 1 from public.profiles p
        where p.id = s.participant_id and p.status = 'active' and p.role = 'participant'
      )
      and s.status in ('draft', 'question_generation')
      and not exists (
        select 1
        from public.questions q
        where q.session_id = s.id
      )
  );
$$;

alter table public.profiles enable row level security;
alter table public.sessions enable row level security;
alter table public.session_contexts enable row level security;
alter table public.session_images enable row level security;
alter table public.questions enable row level security;
alter table public.question_targets enable row level security;
alter table public.answers enable row level security;
alter table public.question_events enable row level security;
alter table public.diaries enable row level security;
alter table public.error_logs enable row level security;

create policy profiles_select_self_or_admin
on public.profiles
for select
to authenticated
using (id = (select auth.uid()) or (select public.is_active_admin()));

create policy sessions_select_owner_or_admin
on public.sessions
for select
to authenticated
using (
  (select public.owns_session(id))
  or (select public.is_active_admin())
);

create policy sessions_insert_own_draft
on public.sessions
for insert
to authenticated
with check (
  participant_id = (select auth.uid())
  and status = 'draft'
  and exists (
    select 1 from public.profiles p
    where p.id = participant_id and p.status = 'active' and p.role = 'participant'
  )
);

create policy sessions_update_own_incomplete
on public.sessions
for update
to authenticated
using (
  participant_id = (select auth.uid())
  and status <> 'completed'
  and exists (
    select 1 from public.profiles p
    where p.id = participant_id and p.status = 'active'
  )
)
with check (
  participant_id = (select auth.uid())
  and status <> 'completed'
  and exists (
    select 1 from public.profiles p
    where p.id = participant_id and p.status = 'active'
  )
);

create policy session_contexts_select_owner_or_admin
on public.session_contexts
for select
to authenticated
using (
  (select public.owns_session(session_id))
  or (select public.is_active_admin())
);

create policy session_contexts_insert_before_question_generation
on public.session_contexts
for insert
to authenticated
with check ((select public.can_edit_session_context(session_id)));

create policy session_contexts_update_before_question_generation
on public.session_contexts
for update
to authenticated
using ((select public.can_edit_session_context(session_id)))
with check ((select public.can_edit_session_context(session_id)));

create policy session_contexts_delete_before_question_generation
on public.session_contexts
for delete
to authenticated
using ((select public.can_edit_session_context(session_id)));

create policy session_images_select_owner_or_admin
on public.session_images
for select
to authenticated
using (
  (select public.owns_session(session_id))
  or (select public.is_active_admin())
);

create policy session_images_insert_before_questions
on public.session_images
for insert
to authenticated
with check ((select public.can_edit_session_context(session_id)));

create policy session_images_update_before_questions
on public.session_images
for update
to authenticated
using ((select public.can_edit_session_context(session_id)))
with check ((select public.can_edit_session_context(session_id)));

create policy session_images_delete_before_questions
on public.session_images
for delete
to authenticated
using ((select public.can_edit_session_context(session_id)));

create policy questions_select_owner_or_admin
on public.questions
for select
to authenticated
using (
  (select public.owns_session(session_id))
  or (select public.is_active_admin())
);

create policy questions_update_owner_incomplete
on public.questions
for update
to authenticated
using ((select public.can_edit_session(session_id)))
with check ((select public.can_edit_session(session_id)));

create policy question_targets_select_owner_or_admin
on public.question_targets
for select
to authenticated
using (
  (select public.owns_session(session_id))
  or (select public.is_active_admin())
);

create policy answers_select_owner_or_admin
on public.answers
for select
to authenticated
using (
  exists (
    select 1 from public.questions q
    where q.id = question_id
      and (select public.owns_session(q.session_id))
  )
  or (select public.is_active_admin())
);

create policy answers_insert_own_active_session
on public.answers
for insert
to authenticated
with check (
  participant_id = (select auth.uid())
  and exists (
    select 1
    from public.questions q
    join public.sessions s on s.id = q.session_id
    where q.id = question_id
      and s.participant_id = (select auth.uid())
      and s.status = 'in_progress'
      and (select public.can_edit_session(s.id))
      and (q.is_active_version or q.question_kind = 'followup')
      and q.status <> 'skipped'
  )
);

create policy answers_update_own_active_session
on public.answers
for update
to authenticated
using (
  participant_id = (select auth.uid())
  and exists (
    select 1
    from public.questions q
    join public.sessions s on s.id = q.session_id
    where q.id = question_id
      and s.participant_id = (select auth.uid())
      and s.status = 'in_progress'
      and (select public.can_edit_session(s.id))
      and (q.is_active_version or q.question_kind = 'followup')
      and q.status <> 'skipped'
  )
)
with check (
  participant_id = (select auth.uid())
  and exists (
    select 1
    from public.questions q
    join public.sessions s on s.id = q.session_id
    where q.id = question_id
      and s.participant_id = (select auth.uid())
      and s.status = 'in_progress'
      and (select public.can_edit_session(s.id))
      and (q.is_active_version or q.question_kind = 'followup')
      and q.status <> 'skipped'
  )
);

create policy question_events_select_owner_or_admin
on public.question_events
for select
to authenticated
using (
  (select public.owns_session(session_id))
  or (select public.is_active_admin())
);

create policy question_events_insert_own_incomplete
on public.question_events
for insert
to authenticated
with check (
  participant_id = (select auth.uid())
  and (select public.can_edit_session(session_id))
);

create policy diaries_select_owner_or_admin
on public.diaries
for select
to authenticated
using (
  (select public.owns_session(session_id))
  or (select public.is_active_admin())
);

create policy diaries_insert_own_completed_session
on public.diaries
for insert
to authenticated
with check (
  participant_id = (select auth.uid())
  and exists (
    select 1
    from public.sessions s
    where s.id = session_id
      and s.participant_id = (select auth.uid())
      and s.status = 'completed'
      and (select public.owns_session(s.id))
  )
);

create policy diaries_update_own_completed_session
on public.diaries
for update
to authenticated
using (
  participant_id = (select auth.uid())
  and exists (
    select 1
    from public.sessions s
    where s.id = session_id
      and s.participant_id = (select auth.uid())
      and s.status = 'completed'
      and (select public.owns_session(s.id))
  )
)
with check (
  participant_id = (select auth.uid())
  and exists (
    select 1
    from public.sessions s
    where s.id = session_id
      and s.participant_id = (select auth.uid())
      and s.status = 'completed'
      and (select public.owns_session(s.id))
  )
);

create policy error_logs_select_admin_only
on public.error_logs
for select
to authenticated
using ((select public.is_active_admin()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'why-box-images',
  'why-box-images',
  false,
  10485760,
  array['image/jpeg', 'image/png']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy why_box_images_select_owner_or_admin
on storage.objects
for select
to authenticated
using (
  bucket_id = 'why-box-images'
  and (
    (
      (storage.foldername(name))[1] = (select auth.uid())::text
      and exists (
        select 1 from public.sessions s
        where s.id::text = (storage.foldername(name))[2]
          and (select public.owns_session(s.id))
      )
    )
    or (select public.is_active_admin())
  )
);

create policy why_box_images_insert_own_prefix
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'why-box-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1
    from public.sessions s
    where s.id::text = (storage.foldername(name))[2]
      and s.participant_id = (select auth.uid())
      and (select public.can_edit_session_context(s.id))
      and s.status in ('draft', 'question_generation')
      and not exists (
        select 1 from public.questions q where q.session_id = s.id
      )
  )
);

create policy why_box_images_update_own_prefix
on storage.objects
for update
to authenticated
using (
  bucket_id = 'why-box-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1
    from public.sessions s
    where s.id::text = (storage.foldername(name))[2]
      and s.participant_id = (select auth.uid())
      and (select public.can_edit_session_context(s.id))
      and s.status in ('draft', 'question_generation')
      and not exists (
        select 1 from public.questions q where q.session_id = s.id
      )
  )
)
with check (
  bucket_id = 'why-box-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1
    from public.sessions s
    where s.id::text = (storage.foldername(name))[2]
      and s.participant_id = (select auth.uid())
      and (select public.can_edit_session_context(s.id))
      and s.status in ('draft', 'question_generation')
      and not exists (
        select 1 from public.questions q where q.session_id = s.id
      )
  )
);

create policy why_box_images_delete_before_questions
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'why-box-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1
    from public.sessions s
    where s.id::text = (storage.foldername(name))[2]
      and s.participant_id = (select auth.uid())
      and (select public.can_edit_session_context(s.id))
      and s.status in ('draft', 'question_generation')
      and not exists (
        select 1 from public.questions q where q.session_id = s.id
      )
  )
);

revoke all on function public.is_active_admin() from public, anon;
revoke all on function public.owns_session(uuid) from public, anon;
revoke all on function public.can_edit_session(uuid) from public, anon;
revoke all on function public.can_edit_session_context(uuid) from public, anon;
grant execute on function public.is_active_admin() to authenticated;
grant execute on function public.owns_session(uuid) to authenticated;
grant execute on function public.can_edit_session(uuid) to authenticated;
grant execute on function public.can_edit_session_context(uuid) to authenticated;

revoke all on public.profiles, public.sessions, public.session_contexts,
  public.session_images, public.questions, public.question_targets,
  public.answers, public.question_events, public.diaries, public.error_logs
  from anon, authenticated;

grant select on public.profiles, public.sessions, public.session_contexts,
  public.session_images, public.questions, public.question_targets,
  public.answers, public.question_events, public.diaries, public.error_logs
  to authenticated;
grant insert, update on public.sessions, public.session_contexts,
  public.session_images, public.diaries to authenticated;
grant delete on public.session_contexts, public.session_images to authenticated;
grant update (status, skip_reason, skipped_at) on public.questions to authenticated;
grant insert (id, question_id, participant_id, original_answer) on public.answers
  to authenticated;
grant update (original_answer) on public.answers to authenticated;
grant insert on public.question_events to authenticated;

grant all on public.profiles, public.sessions, public.session_contexts,
  public.session_images, public.questions, public.question_targets,
  public.answers, public.question_events, public.diaries, public.error_logs
  to service_role;

revoke all on function public.sync_question_answer_status() from public, anon, authenticated;
