-- Apply only after the application accepts both legacy and nested follow-up snapshots.
-- No stored requests, completed sessions, answers or briefing sources are rewritten.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
declare target regprocedure := to_regprocedure('public.session_briefing_input_snapshot(uuid)');
begin
  if target is null then
    raise exception 'Existing briefing snapshot function required';
  end if;
  if not exists (select 1 from pg_proc where oid = target
      and proowner = 'postgres'::regrole and prosecdef)
    or exists (select 1 from aclexplode(coalesce(
      (select proacl from pg_proc where oid = target),
      acldefault('f', 'postgres'::regrole)
    )) where grantee = 0 and privilege_type = 'EXECUTE')
    or has_function_privilege('anon', target, 'EXECUTE')
    or has_function_privilege('authenticated', target, 'EXECUTE')
    or has_function_privilege('service_role', target, 'EXECUTE') then
    raise exception 'Expected private postgres-owned briefing snapshot function';
  end if;
end;
$$;

create or replace function public.session_briefing_input_snapshot(p_session_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'session_id', s.id,
    'design_context', jsonb_build_object(
      'primary_category_id', s.primary_category_id,
      'subcategory_id', s.subcategory_id,
      'other_category_text', s.other_category_text,
      'stage_id', s.stage_id,
      'additional_context', s.additional_context
    ),
    'context_ids', coalesce((
      select jsonb_agg(sc.context_id order by sc.context_id)
      from public.session_contexts sc where sc.session_id = s.id
    ), '[]'::jsonb),
    'answered_questions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'question_id', q.id,
          'slot_index', q.slot_index,
          'question_text', q.question_text,
          'answer', jsonb_build_object(
            'original', a.original_answer,
            'refined', a.refined_answer,
            'current_version', a.current_answer_version,
            'selected', case when a.current_answer_version = 'refined'
              then a.refined_answer else a.original_answer end
          )
        ) || case when child.snapshot is null then '{}'::jsonb
          else jsonb_build_object('followup', child.snapshot) end
        order by q.slot_index, q.id
      )
      from public.questions q
      join public.answers a on a.question_id = q.id
      left join lateral (
        select jsonb_build_object(
          'session_id', fq.session_id,
          'question_id', fq.id,
          'parent_question_id', fq.parent_question_id,
          'question_text', fq.question_text,
          'answer', jsonb_build_object(
            'original', fa.original_answer,
            'refined', fa.refined_answer,
            'current_version', fa.current_answer_version,
            'selected', case when fa.current_answer_version = 'refined'
              then fa.refined_answer else fa.original_answer end
          )
        ) as snapshot
        from public.questions fq
        join public.answers fa on fa.question_id = fq.id
        where fq.session_id = s.id and fq.parent_question_id = q.id
          and fq.root_question_id = q.root_question_id
          and fq.question_kind = 'followup' and fq.status = 'answered'
          and fa.participant_id = s.participant_id
          and (case when fa.current_answer_version = 'refined'
            then coalesce(fa.refined_answer, '') else fa.original_answer end) !~ '^[[:space:]]*$'
        order by fq.followup_index, fq.id
        limit 1
      ) child on true
      where q.session_id = s.id and q.is_active_version
        and q.question_kind in ('original', 'regenerated')
        and q.status = 'answered'
        and length(btrim(case when a.current_answer_version = 'refined'
          then coalesce(a.refined_answer, '') else a.original_answer end)) > 0
    ), '[]'::jsonb)
  )
  from public.sessions s where s.id = p_session_id;
$$;

-- CREATE OR REPLACE preserves the existing postgres owner and private EXECUTE ACL.
commit;
