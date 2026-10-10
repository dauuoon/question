begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.sessions add column context_draft_auto_claimed_at timestamptz;

create function public.guard_context_draft_marker()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.context_draft_auto_claimed_at is not null then
      raise exception 'New sessions cannot start with a draft claim' using errcode = '42501';
    end if;
  elsif new.context_draft_auto_claimed_at is distinct from old.context_draft_auto_claimed_at then
    if old.context_draft_auto_claimed_at is not null then
      raise exception 'Draft claim cannot be reset or changed' using errcode = '42501';
    end if;
    if not public.can_edit_session_context(old.id) then
      raise exception 'Draft claim access denied' using errcode = '42501';
    end if;
    new.context_draft_auto_claimed_at := clock_timestamp();
  end if;
  return new;
end;
$$;

create trigger sessions_context_draft_marker_guard
before insert or update on public.sessions
for each row execute function public.guard_context_draft_marker();

create function public.claim_context_draft(
  p_session_id uuid,
  p_manual boolean,
  p_primary_category_id text,
  p_subcategory_id text,
  p_other_category_text text,
  p_stage_id text,
  p_context_ids text[]
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  session_row public.sessions%rowtype;
  image_count integer;
  category_options constant jsonb := '{
    "ux_ui": ["web_design","mobile_app_design","digital_product_design","service_design","interaction_design","design_system","game_ui_ux_design"],
    "brand_graphic": ["brand_design","graphic_design","poster_design","advertising_campaign_design","content_design","information_design"],
    "editorial_package": ["editorial_print_design","package_design"],
    "illustration_character": ["illustration","character_design","pattern_design","icon_pictogram_design"],
    "video_motion": ["video_thumbnail_design","video_graphic_design","motion_graphic_design"],
    "product_spatial": ["industrial_product_design","spatial_design","exhibition_design","signage_environmental_graphic_design"],
    "others": ["other"]
  }';
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'participant' and p.status = 'active'
  ) then
    raise exception 'Active Participant required' using errcode = '42501';
  end if;
  select * into session_row from public.sessions s
  where s.id = p_session_id and s.participant_id = auth.uid()
  for update;
  if not found or session_row.status not in ('draft', 'question_generation')
    or exists (select 1 from public.questions q where q.session_id = p_session_id) then
    raise exception 'Draft generation access denied' using errcode = '42501';
  end if;

  -- Validate the UI snapshot without changing or waiting for the autosaved research inputs.
  if p_manual is null or p_primary_category_id is null or p_subcategory_id is null
    or not (category_options ? p_primary_category_id)
    or not coalesce((category_options -> p_primary_category_id) ? p_subcategory_id, false)
    or (p_primary_category_id = 'others' and length(btrim(coalesce(p_other_category_text, ''))) = 0)
    or (p_primary_category_id <> 'others' and nullif(p_other_category_text, '') is not null)
    or p_stage_id is null or p_stage_id <> all(array[
      'research_problem_definition','idea_concept','structure_design',
      'visualization_specification','review_improvement'
    ])
    or p_context_ids is null or cardinality(p_context_ids) not between 1 and 3
    or (select count(distinct c.id) from unnest(p_context_ids) c(id)) <> cardinality(p_context_ids)
    or exists (select 1 from unnest(p_context_ids) c(id) where c.id is null or c.id <> all(array[
      'problem_and_goal','design_concept','user_perspective','information_element_structure',
      'visual_form','other_perspectives','decision_reasoning','intent_alignment','next_steps'
    ])) then
    raise exception 'Invalid draft generation inputs' using errcode = '22023';
  end if;
  select count(*) into image_count from public.session_images si where si.session_id = p_session_id;
  if image_count not between 1 and 10 then
    raise exception 'Registered images required' using errcode = '22023';
  end if;
  if not p_manual and session_row.context_draft_auto_claimed_at is not null then
    return false;
  end if;
  if session_row.context_draft_auto_claimed_at is null then
    update public.sessions set context_draft_auto_claimed_at = clock_timestamp() where id = p_session_id;
    if not found then
      raise exception 'Draft claim denied' using errcode = '42501';
    end if;
  end if;
  -- Existing participant-authored text also consumes the automatic opportunity, never overwrites it.
  if not p_manual and length(coalesce(session_row.additional_context, '')) > 0 then
    return false;
  end if;
  return true;
end;
$$;

revoke all on function public.guard_context_draft_marker() from public, anon, authenticated, service_role;
revoke all on function public.claim_context_draft(uuid, boolean, text, text, text, text, text[])
  from public, anon, authenticated, service_role;
grant execute on function public.claim_context_draft(uuid, boolean, text, text, text, text, text[])
  to authenticated;
commit;
