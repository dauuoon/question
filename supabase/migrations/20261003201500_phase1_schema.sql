create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  participant_code text,
  role text not null default 'participant'
    check (role in ('participant', 'admin')),
  status text not null default 'active'
    check (status in ('active', 'deactivated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_role_code_check check (
    (role = 'admin' and participant_code is null)
    or
    (role = 'participant' and participant_code is not null)
  ),
  constraint profiles_participant_code_format_check check (
    participant_code is null or participant_code ~ '^P[0-9]{2,}$'
  )
);

create unique index profiles_participant_code_unique
  on public.profiles (upper(participant_code))
  where participant_code is not null;

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.profiles (id) on delete restrict,
  status text not null default 'draft'
    check (status in (
      'draft',
      'question_generation',
      'in_progress',
      'summary_ready',
      'completed'
    )),
  primary_category_id text,
  subcategory_id text,
  other_category_text text,
  stage_id text,
  additional_context text,
  requested_question_count integer not null default 3
    check (requested_question_count between 1 and 5),
  summary_text text,
  model_id text,
  prompt_version text,
  framework_version text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sessions_completed_at_check check (
    (status = 'completed' and completed_at is not null)
    or
    (status <> 'completed' and completed_at is null)
  )
);

create index sessions_participant_status_completed_idx
  on public.sessions (participant_id, status, completed_at, id);

create table public.session_contexts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete restrict,
  context_id text not null,
  created_at timestamptz not null default now(),
  constraint session_contexts_session_context_unique unique (session_id, context_id)
);

create table public.session_images (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete restrict,
  storage_path text not null unique,
  original_filename text not null,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png')),
  file_size bigint not null check (file_size > 0 and file_size <= 10485760),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  sort_order integer not null check (sort_order >= 0),
  created_at timestamptz not null default now(),
  constraint session_images_id_session_unique unique (id, session_id),
  constraint session_images_session_sort_unique unique (session_id, sort_order)
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete restrict,
  root_question_id uuid not null,
  parent_question_id uuid,
  question_kind text not null
    check (question_kind in ('original', 'regenerated', 'followup')),
  slot_index integer not null check (slot_index between 1 and 5),
  regeneration_index integer,
  followup_index integer,
  question_text text not null check (length(btrim(question_text)) > 0),
  content_principle text,
  detail_type text,
  target_type text not null check (target_type in ('region', 'image', 'multi_image')),
  selection_reason text not null,
  status text not null default 'unprocessed'
    check (status in ('unprocessed', 'answered', 'skipped')),
  is_active_version boolean not null default true,
  skip_reason text,
  model_id text not null,
  prompt_version text not null,
  framework_version text not null,
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  skipped_at timestamptz,
  constraint questions_id_session_unique unique (id, session_id),
  constraint questions_root_same_session_fk
    foreign key (root_question_id, session_id)
    references public.questions (id, session_id)
    on delete restrict
    deferrable initially deferred,
  constraint questions_parent_same_session_fk
    foreign key (parent_question_id, session_id)
    references public.questions (id, session_id)
    on delete restrict
    deferrable initially deferred,
  constraint questions_lineage_shape_check check (
    (
      question_kind = 'original'
      and root_question_id = id
      and parent_question_id is null
      and regeneration_index is not null
      and regeneration_index = 0
      and followup_index is null
    )
    or
    (
      question_kind = 'regenerated'
      and root_question_id <> id
      and parent_question_id is not null
      and regeneration_index is not null
      and regeneration_index between 1 and 2
      and followup_index is null
    )
    or
    (
      question_kind = 'followup'
      and root_question_id <> id
      and parent_question_id is not null
      and regeneration_index is null
      and followup_index is not null
      and followup_index between 1 and 2
      and not is_active_version
    )
  ),
  constraint questions_status_timestamps_check check (
    (status = 'answered' and answered_at is not null and skipped_at is null)
    or
    (status = 'skipped' and skipped_at is not null and answered_at is null)
    or
    (status = 'unprocessed' and answered_at is null and skipped_at is null)
  )
);

create unique index questions_original_slot_unique
  on public.questions (session_id, slot_index)
  where question_kind = 'original';

create unique index questions_one_active_version_per_slot
  on public.questions (session_id, slot_index)
  where question_kind in ('original', 'regenerated') and is_active_version;

create unique index questions_regeneration_index_unique
  on public.questions (root_question_id, regeneration_index)
  where question_kind = 'regenerated';

create unique index questions_followup_index_unique
  on public.questions (root_question_id, followup_index)
  where question_kind = 'followup';

create index questions_session_slot_idx
  on public.questions (session_id, slot_index, created_at);

create table public.question_targets (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null,
  session_id uuid not null,
  image_id uuid not null,
  x double precision,
  y double precision,
  width double precision,
  height double precision,
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  constraint question_targets_image_unique unique (question_id, image_id),
  constraint question_targets_question_fk
    foreign key (question_id, session_id)
    references public.questions (id, session_id)
    on delete restrict,
  constraint question_targets_image_fk
    foreign key (image_id, session_id)
    references public.session_images (id, session_id)
    on delete restrict,
  constraint question_targets_coordinates_check check (
    (
      x is null and y is null and width is null and height is null
    )
    or
    (
      x between 0 and 1
      and x is not null and y is not null and width is not null and height is not null
      and y between 0 and 1
      and width between 0 and 1
      and height between 0 and 1
      and x + width <= 1
      and y + height <= 1
    )
  )
);

create table public.answers (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null unique references public.questions (id) on delete restrict,
  participant_id uuid not null references public.profiles (id) on delete restrict,
  original_answer text not null default '',
  refined_answer text,
  refinement_used boolean not null default false,
  refined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint answers_refinement_check check (
    (not refinement_used and refined_answer is null and refined_at is null)
    or (refinement_used and refined_answer is not null and refined_at is not null)
  )
);

create index answers_participant_idx on public.answers (participant_id);

create table public.question_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete restrict,
  question_id uuid references public.questions (id) on delete restrict,
  participant_id uuid not null references public.profiles (id) on delete restrict,
  event_type text not null check (event_type in (
    'question_opened',
    'answer_started',
    'answer_saved',
    'answer_refined',
    'question_skipped',
    'question_regenerated',
    'followup_requested'
  )),
  event_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.question_events
  add constraint question_events_question_session_fk
  foreign key (question_id, session_id)
  references public.questions (id, session_id)
  on delete restrict;

create index question_events_session_created_idx
  on public.question_events (session_id, created_at);

create table public.diaries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.sessions (id) on delete restrict,
  participant_id uuid not null references public.profiles (id) on delete restrict,
  experience_choices_json jsonb not null default '[]'::jsonb
    check (jsonb_typeof(experience_choices_json) = 'array'),
  feeling_choices_json jsonb not null default '[]'::jsonb
    check (jsonb_typeof(feeling_choices_json) = 'array'),
  free_text text,
  status text not null default 'not_started'
    check (status in ('not_started', 'submitted')),
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint diaries_status_submission_check check (
    (status = 'not_started' and submitted_at is null)
    or (
      status = 'submitted'
      and submitted_at is not null
      and jsonb_array_length(experience_choices_json) > 0
      and jsonb_array_length(feeling_choices_json) > 0
    )
  )
);

create table public.error_logs (
  id uuid primary key default gen_random_uuid(),
  error_code text not null,
  error_type text not null check (
    error_type in ('AUTH', 'UPLOAD', 'AI', 'SAVE', 'NETWORK', 'UNKNOWN')
  ),
  participant_id uuid references public.profiles (id) on delete set null,
  session_id uuid references public.sessions (id) on delete set null,
  related_question_id uuid references public.questions (id) on delete set null,
  internal_error_message text not null,
  retryable boolean not null default false,
  occurred_at timestamptz not null default now()
);

create index error_logs_occurred_at_idx on public.error_logs (occurred_at desc);
create index error_logs_participant_session_idx
  on public.error_logs (participant_id, session_id, occurred_at desc);

create function public.enforce_session_context_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  context_count integer;
begin
  if tg_op = 'UPDATE' and new.session_id <> old.session_id then
    raise exception 'Reflection context session association is immutable';
  end if;

  perform 1
  from public.sessions s
  where s.id = new.session_id
  for update;

  select count(*) into context_count
  from public.session_contexts sc
  where sc.session_id = new.session_id;

  if tg_op = 'INSERT' and context_count >= 3 then
    raise exception 'A session can have at most three reflection contexts';
  end if;
  return new;
end;
$$;

create trigger session_context_limit_guard
before insert or update on public.session_contexts
for each row execute function public.enforce_session_context_limit();

create function public.enforce_session_image_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  image_count integer;
begin
  if tg_op = 'UPDATE' and (
    new.id <> old.id or new.session_id <> old.session_id
    or new.storage_path <> old.storage_path or new.created_at <> old.created_at
  ) then
    raise exception 'Image identity, session association, and storage path are immutable';
  end if;

  perform 1
  from public.sessions s
  where s.id = new.session_id
  for update;

  select count(*) into image_count
  from public.session_images si
  where si.session_id = new.session_id;

  if not exists (
    select 1 from public.sessions s
    where s.id = new.session_id
      and split_part(new.storage_path, '/', 1) = s.participant_id::text
      and split_part(new.storage_path, '/', 2) = s.id::text
      and split_part(new.storage_path, '/', 3) <> ''
  ) then
    raise exception 'Image storage path must belong to its participant and session';
  end if;

  if tg_op = 'INSERT' and image_count >= 10 then
    raise exception 'A session can have at most ten images';
  end if;
  return new;
end;
$$;

create trigger session_image_limit_guard
before insert or update on public.session_images
for each row execute function public.enforce_session_image_limit();

create function public.validate_question_target()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  question_target_type text;
begin
  select q.target_type into question_target_type
  from public.questions q
  where q.id = new.question_id
    and q.session_id = new.session_id;

  if not found then
    raise exception 'Target question must belong to the specified session';
  end if;

  if question_target_type = 'region' then
    if new.x is null or new.y is null or new.width is null or new.height is null then
      raise exception 'Region targets require normalized coordinates';
    end if;

    if exists (
      select 1
      from public.question_targets qt
      where qt.question_id = new.question_id
        and qt.id <> new.id
    ) then
      raise exception 'A region target must reference exactly one image';
    end if;
  elsif new.x is not null or new.y is not null
    or new.width is not null or new.height is not null then
    raise exception 'Whole-image targets cannot contain region coordinates';
  end if;

  return new;
end;
$$;

create trigger question_targets_shape_guard
before insert or update on public.question_targets
for each row execute function public.validate_question_target();

create function public.enforce_question_lineage()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  root_row public.questions%rowtype;
  parent_row public.questions%rowtype;
  version_count integer;
begin
  if tg_op = 'UPDATE' then
    if not old.is_active_version and new.is_active_version then
      raise exception 'Inactive question versions cannot be reactivated';
    end if;
    if new.id <> old.id
      or new.session_id <> old.session_id
      or new.root_question_id <> old.root_question_id
      or new.parent_question_id is distinct from old.parent_question_id
      or new.question_kind <> old.question_kind
      or new.slot_index <> old.slot_index
      or new.regeneration_index is distinct from old.regeneration_index
      or new.followup_index is distinct from old.followup_index
      or new.question_text <> old.question_text
      or new.content_principle is distinct from old.content_principle
      or new.detail_type is distinct from old.detail_type
      or new.target_type is distinct from old.target_type
      or new.selection_reason is distinct from old.selection_reason
      or new.model_id is distinct from old.model_id
      or new.prompt_version is distinct from old.prompt_version
      or new.framework_version is distinct from old.framework_version
      or new.generated_at is distinct from old.generated_at
      or new.created_at <> old.created_at then
      raise exception 'Question version content and lineage are immutable';
    end if;

    if old.status = 'answered' and new.status <> old.status
      and not (
        new.status = 'unprocessed'
        and exists (
          select 1 from public.answers a
          where a.question_id = new.id and length(btrim(a.original_answer)) = 0
        )
      ) then
      raise exception 'Answered status can only be cleared with an empty autosaved answer';
    end if;

    if old.status = 'answered' and new.status = 'answered'
      and new.answered_at is distinct from old.answered_at then
      raise exception 'Answered timestamp is immutable';
    end if;

    if old.status = 'answered'
      and old.is_active_version
      and not new.is_active_version then
      raise exception 'An answered active question cannot be regenerated';
    end if;

    if old.status = 'skipped' and new.status <> old.status then
      raise exception 'Skipped question status is immutable';
    end if;

    if old.status = 'skipped'
      and (
        new.skipped_at is distinct from old.skipped_at
        or new.skip_reason is distinct from old.skip_reason
      ) then
      raise exception 'Skipped question record is immutable';
    end if;

    if old.is_active_version is distinct from new.is_active_version
      and coalesce(auth.role(), '') <> 'service_role' then
      raise exception 'Only the trusted server can switch active question versions';
    end if;

    if new.status = 'answered' and not exists (
      select 1 from public.answers a
      where a.question_id = new.id and length(btrim(a.original_answer)) > 0
    ) then
      raise exception 'A question can only be answered when an answer exists';
    end if;

    if new.status = 'unprocessed' and exists (
      select 1 from public.answers a
      where a.question_id = new.id and length(btrim(a.original_answer)) > 0
    ) then
      raise exception 'A written answer requires answered question status';
    end if;

    if new.status = 'skipped' and old.status = 'unprocessed' then
      if exists (
        select 1 from public.answers a
        where a.question_id = new.id and length(btrim(a.original_answer)) > 0
      ) then
        raise exception 'A question with a written answer cannot be skipped';
      end if;
      if not old.is_active_version and old.question_kind <> 'followup' then
        raise exception 'Only the active question can be skipped';
      end if;
      new.skipped_at := coalesce(new.skipped_at, now());
    end if;

    if new.status = 'unprocessed' then
      new.answered_at := null;
      new.skipped_at := null;
    end if;

    return new;
  end if;

  if new.question_kind = 'original' then
    if new.root_question_id is null then
      new.root_question_id := new.id;
    elsif new.root_question_id <> new.id then
      raise exception 'An original question must be its own root';
    end if;
    return new;
  end if;

  select * into root_row
  from public.questions
  where id = new.root_question_id
  for update;

  if not found
    or root_row.session_id <> new.session_id
    or root_row.question_kind <> 'original'
    or root_row.slot_index <> new.slot_index then
    raise exception 'Question root must be the original question in the same slot';
  end if;

  select * into parent_row
  from public.questions
  where id = new.parent_question_id
  for update;

  if not found
    or parent_row.session_id <> new.session_id
    or parent_row.root_question_id <> new.root_question_id then
    raise exception 'Question parent must belong to the same question lineage';
  end if;

  if new.question_kind = 'regenerated' then
    if parent_row.question_kind not in ('original', 'regenerated')
      or parent_row.slot_index <> new.slot_index
      or parent_row.is_active_version
      or parent_row.status = 'answered'
      or not new.is_active_version
      or new.regeneration_index <> coalesce(parent_row.regeneration_index, 0) + 1 then
      raise exception 'Regeneration parent, status, or sequence is invalid';
    end if;

    if exists (
      select 1 from public.questions q
      where q.root_question_id = new.root_question_id
        and q.question_kind in ('original', 'regenerated')
        and q.regeneration_index > parent_row.regeneration_index
    ) or exists (
      select 1 from public.answers a
      where a.question_id = parent_row.id and length(btrim(a.original_answer)) > 0
    ) then
      raise exception 'Regeneration must extend the latest unanswered version';
    end if;

    select count(*) into version_count
    from public.questions
    where root_question_id = new.root_question_id
      and question_kind = 'regenerated';

    if version_count >= 2 then
      raise exception 'A question slot can only be regenerated twice';
    end if;
  else
    if parent_row.question_kind not in ('original', 'regenerated', 'followup')
      or parent_row.slot_index <> new.slot_index
      or parent_row.status <> 'answered' then
      raise exception 'Follow-up parent must be a question version in the same slot';
    end if;

    select count(*) into version_count
    from public.questions
    where root_question_id = new.root_question_id
      and question_kind = 'followup';

    if version_count >= 2 then
      raise exception 'A question root can only have two follow-ups';
    end if;
    if new.followup_index <> version_count + 1 then
      raise exception 'Follow-up indexes must follow creation order';
    end if;
  end if;

  return new;
end;
$$;

create trigger questions_lineage_guard
before insert or update on public.questions
for each row execute function public.enforce_question_lineage();

create function public.ensure_one_active_question_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  active_count integer;
begin
  if new.question_kind not in ('original', 'regenerated') then
    return null;
  end if;

  select count(*) into active_count
  from public.questions q
  where q.session_id = new.session_id
    and q.slot_index = new.slot_index
    and q.question_kind in ('original', 'regenerated')
    and q.is_active_version;

  if active_count <> 1 then
    raise exception 'Each generated question slot must have exactly one active version';
  end if;
  return null;
end;
$$;

create constraint trigger questions_one_active_version_guard
after insert or update on public.questions
deferrable initially deferred
for each row execute function public.ensure_one_active_question_version();

create function public.validate_answer_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  question_row public.questions%rowtype;
begin
  if tg_op = 'UPDATE' and (
    new.id <> old.id
    or new.question_id <> old.question_id
    or new.participant_id <> old.participant_id
    or new.created_at <> old.created_at
  ) then
    raise exception 'Answer identity and question association are immutable';
  end if;

  select q.* into question_row
  from public.questions q
  join public.sessions s on s.id = q.session_id
  where q.id = new.question_id
    and s.participant_id = new.participant_id
  for update of q;

  if not found
    or (not question_row.is_active_version and question_row.question_kind <> 'followup')
    or question_row.status = 'skipped' then
    raise exception 'Answers can only be saved to an active, unskipped question owned by the participant';
  end if;

  if tg_op = 'UPDATE' then
    if old.refinement_used and not new.refinement_used then
      raise exception 'Refinement usage history cannot be cleared';
    end if;
    if (
      new.refined_answer is distinct from old.refined_answer
      or new.refinement_used is distinct from old.refinement_used
      or new.refined_at is distinct from old.refined_at
    ) and new.original_answer <> old.original_answer then
      raise exception 'Refinement must not overwrite the original answer';
    end if;
  end if;

  return new;
end;
$$;

create trigger answers_validate_write
before insert or update on public.answers
for each row execute function public.validate_answer_write();

create function public.sync_question_answer_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  question_row public.questions%rowtype;
begin
  select q.* into question_row
  from public.questions q
  where q.id = new.question_id
  for update;

  if question_row.status = 'unprocessed'
    and length(btrim(new.original_answer)) > 0 then
    update public.questions
    set status = 'answered', answered_at = now()
    where id = new.question_id;
  elsif question_row.status = 'answered'
    and length(btrim(new.original_answer)) = 0 then
    update public.questions
    set status = 'unprocessed', answered_at = null
    where id = new.question_id;
  end if;

  return new;
end;
$$;

create trigger answers_sync_question_status
after insert or update of original_answer, question_id on public.answers
for each row execute function public.sync_question_answer_status();

create function public.guard_completed_session()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  active_slots integer;
  processed_slots integer;
  answered_slots integer;
begin
  if new.id <> old.id or new.participant_id <> old.participant_id
    or new.created_at <> old.created_at then
    raise exception 'Session identity and ownership are immutable';
  end if;

  if exists (select 1 from public.questions q where q.session_id = old.id)
    and (
      new.primary_category_id is distinct from old.primary_category_id
      or new.subcategory_id is distinct from old.subcategory_id
      or new.other_category_text is distinct from old.other_category_text
      or new.stage_id is distinct from old.stage_id
      or new.additional_context is distinct from old.additional_context
      or new.requested_question_count <> old.requested_question_count
    ) then
    raise exception 'Generated question context is immutable';
  end if;

  if old.status = 'completed' then
    raise exception 'Completed sessions are immutable';
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'draft' and new.status = 'question_generation')
      or (old.status = 'question_generation' and new.status = 'in_progress')
      or (old.status = 'in_progress' and new.status = 'summary_ready')
      or (old.status = 'summary_ready' and new.status = 'completed')
    ) then
      raise exception 'Invalid session status transition';
    end if;
  end if;

  if new.status = 'in_progress' and old.status = 'question_generation' then
    if (
      select count(*)
      from public.questions q
      where q.session_id = new.id
        and q.question_kind = 'original'
    ) <> new.requested_question_count then
      raise exception 'Generated original question count does not match the requested count';
    end if;

    if exists (
      select 1
      from public.questions q
      where q.session_id = new.id
        and q.question_kind = 'original'
        and not exists (
          select 1
          from public.question_targets qt
          where qt.question_id = q.id
        )
    ) then
      raise exception 'Every original question must have at least one image target';
    end if;

    if exists (
      select 1
      from public.questions q
      where q.session_id = new.id
        and q.question_kind = 'original'
        and (
          (
            q.target_type in ('region', 'image')
            and (
              select count(*) from public.question_targets qt
              where qt.question_id = q.id
            ) <> 1
          )
          or (
            q.target_type = 'multi_image'
            and (
              select count(*) from public.question_targets qt
              where qt.question_id = q.id
            ) < 2
          )
        )
    ) then
      raise exception 'Question target rows do not match the declared target type';
    end if;

    new.started_at := coalesce(new.started_at, now());
  end if;

  if new.status in ('summary_ready', 'completed') then
    select count(*) into active_slots
    from public.questions q
    where q.session_id = new.id
      and q.question_kind in ('original', 'regenerated')
      and q.is_active_version;

    select count(*) into processed_slots
    from public.questions q
    where q.session_id = new.id
      and q.question_kind in ('original', 'regenerated')
      and q.is_active_version
      and q.status in ('answered', 'skipped');

    select count(*) into answered_slots
    from public.questions q
    join public.answers a on a.question_id = q.id
    where q.session_id = new.id
      and q.question_kind in ('original', 'regenerated')
      and q.is_active_version
      and q.status = 'answered'
      and length(btrim(a.original_answer)) > 0;

    if active_slots = 0 or processed_slots <> active_slots or answered_slots = 0 then
      raise exception 'Session is not ready for reflection summary';
    end if;
  end if;

  if new.status = 'completed' and old.status = 'summary_ready'
    and length(btrim(coalesce(new.summary_text, ''))) = 0 then
    raise exception 'A saved reflection summary is required to complete a session';
  end if;

  if new.status = 'completed' and old.status = 'summary_ready' then
    new.completed_at := now();
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger sessions_state_guard
before update on public.sessions
for each row execute function public.guard_completed_session();

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger answers_set_updated_at
before update on public.answers
for each row execute function public.set_updated_at();

create trigger diaries_set_updated_at
before update on public.diaries
for each row execute function public.set_updated_at();

create function public.guard_research_child_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_session_id uuid;
  session_row public.sessions%rowtype;
begin
  if tg_table_name = 'answers' then
    select q.session_id into target_session_id
    from public.questions q where q.id = new.question_id;
  else
    target_session_id := new.session_id;
  end if;

  select * into session_row
  from public.sessions where id = target_session_id
  for update;

  if not found then
    raise exception 'Research record requires an existing session';
  end if;

  if tg_op = 'UPDATE' and tg_table_name in ('question_targets', 'question_events') then
    raise exception 'Question targets and events are immutable research history';
  end if;

  if tg_table_name = 'diaries' then
    if session_row.status <> 'completed'
      or new.participant_id <> session_row.participant_id then
      raise exception 'Diary requires its participant''s completed session';
    end if;
    if tg_op = 'UPDATE' and (
      new.id <> old.id or new.session_id <> old.session_id
      or new.participant_id <> old.participant_id
      or new.created_at <> old.created_at
    ) then
      raise exception 'Diary identity and session association are immutable';
    end if;
  else
    if session_row.status = 'completed' then
      raise exception 'Completed reflection data is read-only';
    end if;
    if tg_table_name in ('session_contexts', 'session_images') and (
      session_row.status not in ('draft', 'question_generation')
      or exists (
        select 1 from public.questions q where q.session_id = target_session_id
      )
    ) then
      raise exception 'Context and images are frozen after question generation';
    end if;
    if tg_table_name = 'answers' and session_row.status <> 'in_progress' then
      raise exception 'Answers are editable only while reflection is in progress';
    end if;
    if tg_table_name = 'questions' and tg_op = 'INSERT' then
      if (new.question_kind = 'original' and session_row.status <> 'question_generation')
        or (new.question_kind <> 'original' and session_row.status <> 'in_progress')
        or new.slot_index > session_row.requested_question_count then
        raise exception 'Question generation stage or slot is invalid';
      end if;
    end if;
    if tg_table_name = 'question_events' then
      if new.participant_id <> session_row.participant_id then
        raise exception 'Question event participant must own the session';
      end if;
    end if;
  end if;

  return new;
end;
$$;

create trigger answers_00_session_guard
before insert or update on public.answers
for each row execute function public.guard_research_child_write();
create trigger questions_00_session_guard
before insert or update on public.questions
for each row execute function public.guard_research_child_write();
create trigger question_targets_00_session_guard
before insert or update on public.question_targets
for each row execute function public.guard_research_child_write();
create trigger session_contexts_00_session_guard
before insert or update on public.session_contexts
for each row execute function public.guard_research_child_write();
create trigger session_images_00_session_guard
before insert or update on public.session_images
for each row execute function public.guard_research_child_write();
create trigger question_events_00_session_guard
before insert or update on public.question_events
for each row execute function public.guard_research_child_write();
create trigger diaries_00_session_guard
before insert or update on public.diaries
for each row execute function public.guard_research_child_write();

create function public.guard_research_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name in ('session_contexts', 'session_images') then
    perform 1 from public.sessions s where s.id = old.session_id for update;
    if exists (
      select 1 from public.sessions s
      where s.id = old.session_id and s.status in ('draft', 'question_generation')
    )
    and not exists (
      select 1 from public.questions q where q.session_id = old.session_id
    ) then
      return old;
    end if;
  end if;
  raise exception 'Research history cannot be deleted';
end;
$$;

create trigger sessions_delete_guard
before delete on public.sessions
for each row execute function public.guard_research_delete();
create trigger questions_delete_guard
before delete on public.questions
for each row execute function public.guard_research_delete();
create trigger answers_delete_guard
before delete on public.answers
for each row execute function public.guard_research_delete();
create trigger question_targets_delete_guard
before delete on public.question_targets
for each row execute function public.guard_research_delete();
create trigger question_events_delete_guard
before delete on public.question_events
for each row execute function public.guard_research_delete();
create trigger diaries_delete_guard
before delete on public.diaries
for each row execute function public.guard_research_delete();
create trigger session_contexts_delete_guard
before delete on public.session_contexts
for each row execute function public.guard_research_delete();
create trigger session_images_delete_guard
before delete on public.session_images
for each row execute function public.guard_research_delete();

create function public.validate_new_session()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'draft' or new.summary_text is not null then
    raise exception 'New sessions must start as draft without a summary';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = new.participant_id and p.role = 'participant' and p.status = 'active'
  ) then
    raise exception 'Sessions require an active participant';
  end if;
  return new;
end;
$$;

create trigger sessions_insert_guard
before insert on public.sessions
for each row execute function public.validate_new_session();

create function public.ensure_question_targets()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_question_id uuid;
  question_row public.questions%rowtype;
  target_count integer;
begin
  if tg_table_name = 'questions' then
    target_question_id := new.id;
  else
    target_question_id := new.question_id;
  end if;
  select * into question_row from public.questions where id = target_question_id;
  select count(*) into target_count
  from public.question_targets where question_id = target_question_id;
  if (
    question_row.target_type in ('region', 'image') and target_count <> 1
  ) or (
    question_row.target_type = 'multi_image' and target_count < 2
  ) then
    raise exception 'Every question version requires targets matching its declared type';
  end if;
  return null;
end;
$$;

create constraint trigger questions_targets_required
after insert on public.questions
deferrable initially deferred
for each row execute function public.ensure_question_targets();
create constraint trigger question_targets_cardinality_guard
after insert or update on public.question_targets
deferrable initially deferred
for each row execute function public.ensure_question_targets();
