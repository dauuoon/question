begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function public.save_session_context(
  p_session_id uuid,
  p_primary_category_id text,
  p_subcategory_id text,
  p_other_category_text text,
  p_stage_id text,
  p_additional_context text,
  p_context_ids text[]
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  session_row public.sessions%rowtype;
  old_contexts text[];
  new_contexts text[];
  other_text text := nullif(p_other_category_text, '');
  context_text text := nullif(p_additional_context, '');
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
    raise exception 'Active Participant authentication required' using errcode = '42501';
  end if;

  select * into session_row from public.sessions s
  where s.id = p_session_id and s.participant_id = auth.uid()
  for update;
  if not found then
    raise exception 'Session access denied' using errcode = '42501';
  end if;
  if session_row.status not in ('draft', 'question_generation')
    or exists (select 1 from public.questions q where q.session_id = p_session_id) then
    raise exception 'Session context is read-only' using errcode = '42501';
  end if;

  if (p_primary_category_id is not null and not (category_options ? p_primary_category_id))
    or (p_subcategory_id is not null and (
      p_primary_category_id is null
      or not coalesce((category_options -> p_primary_category_id) ? p_subcategory_id, false)
    ))
    or (other_text is not null and p_primary_category_id is distinct from 'others')
    or (p_stage_id is not null and p_stage_id <> all(array[
      'research_problem_definition','idea_concept','structure_design',
      'visualization_specification','review_improvement'
    ]))
    or char_length(coalesce(context_text, '')) > 1000 then
    raise exception 'Invalid session context input' using errcode = '22023';
  end if;
  if p_context_ids is null or cardinality(p_context_ids) > 3
    or exists (
      select 1 from unnest(p_context_ids) c(id)
      where c.id is null or c.id <> all(array[
        'problem_and_goal','design_concept','user_perspective','information_element_structure',
        'visual_form','other_perspectives','decision_reasoning','intent_alignment','next_steps'
      ])
    )
    or (select count(distinct c.id) from unnest(p_context_ids) c(id)) <> cardinality(p_context_ids) then
    raise exception 'Invalid reflection context selections' using errcode = '22023';
  end if;

  select coalesce(array_agg(c.id order by c.id), array[]::text[]) into new_contexts
  from unnest(p_context_ids) c(id);
  select coalesce(array_agg(sc.context_id order by sc.context_id), array[]::text[]) into old_contexts
  from public.session_contexts sc where sc.session_id = p_session_id;

  if session_row.primary_category_id is not distinct from p_primary_category_id
    and session_row.subcategory_id is not distinct from p_subcategory_id
    and session_row.other_category_text is not distinct from other_text
    and session_row.stage_id is not distinct from p_stage_id
    and session_row.additional_context is not distinct from context_text
    and old_contexts = new_contexts then
    return false;
  end if;

  update public.sessions set
    primary_category_id = p_primary_category_id,
    subcategory_id = p_subcategory_id,
    other_category_text = other_text,
    stage_id = p_stage_id,
    additional_context = context_text
  where id = p_session_id;
  if not found then
    raise exception 'Session update denied' using errcode = '42501';
  end if;

  delete from public.session_contexts sc
  where sc.session_id = p_session_id and not (sc.context_id = any(new_contexts));
  insert into public.session_contexts (session_id, context_id)
  select p_session_id, c.id from unnest(new_contexts) c(id)
  where not exists (
    select 1 from public.session_contexts sc
    where sc.session_id = p_session_id and sc.context_id = c.id
  );
  return true;
end;
$$;

revoke all on function public.save_session_context(uuid, text, text, text, text, text, text[])
  from public, anon, authenticated, service_role;
grant execute on function public.save_session_context(uuid, text, text, text, text, text, text[])
  to authenticated;
commit;
