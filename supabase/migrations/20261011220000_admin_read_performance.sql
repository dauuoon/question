begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Read-only draft: apply only after approval. Invoker rights retain all existing RLS.
create function public.admin_dashboard_read(p_page integer default 1, p_filter text default 'P')
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if not coalesce(public.is_active_admin(), false) then
    raise exception 'ADMIN-READ-DENIED: active administrator required' using errcode = '42501';
  end if;
  if p_page is null or p_page < 1 or p_filter is null
    or p_filter not in ('P', 'T', 'all', 'unclassified') then
    raise exception 'ADMIN-READ-INPUT: invalid page or filter' using errcode = '22023';
  end if;
  -- All counts, activity and page boundaries share this statement's snapshot.
  return (
    with accounts as materialized (
      select id, participant_code, account_type from public.profiles where role = 'participant'
    ), base as materialized (
      select s.id, s.participant_id, s.created_at, s.updated_at, s.status,
        s.requested_question_count, p.participant_code, p.account_type
      from public.sessions s join accounts p on p.id = s.participant_id
    ), filtered as materialized (
      select * from base where p_filter = 'all'
        or (p_filter = 'unclassified' and account_type is null) or account_type = p_filter
    ), bounds as (
      select greatest(1, (count(*) + 19) / 20) as pages from filtered
    ), paging as (
      select least(p_page::bigint, pages) as page, pages from bounds
    ), question_counts as (
      select q.session_id,
        count(*) filter (where q.is_active_version) as questions,
        count(*) filter (where q.is_active_version and q.status = 'answered') as answered,
        count(*) filter (where q.is_active_version and q.status = 'skipped') as skipped
      from public.questions q join filtered s on s.id = q.session_id group by q.session_id
    ), activity as (
      select id as session_id, updated_at as at from filtered
      union all
      select q.session_id, greatest(q.created_at, q.answered_at, q.skipped_at)
        from public.questions q join filtered s on s.id = q.session_id
      union all
      select q.session_id, a.updated_at from public.answers a
        join public.questions q on q.id = a.question_id join filtered s on s.id = q.session_id
      union all
      select d.session_id, d.updated_at from public.diaries d join filtered s on s.id = d.session_id
      union all
      select v.session_id, v.edited_at from public.session_briefing_versions v join filtered s on s.id = v.session_id
      union all
      select i.session_id, i.created_at from public.session_images i join filtered s on s.id = i.session_id
    ), latest as (
      select session_id, max(at) as last_activity_at from activity group by session_id
    ), recent as (
      select s.*, true as is_participant, l.last_activity_at,
        coalesce(q.questions, 0) as questions, coalesce(q.answered, 0) as answered,
        coalesce(q.skipped, 0) as skipped
      from filtered s join latest l on l.session_id = s.id
        left join question_counts q on q.session_id = s.id
      order by l.last_activity_at desc, s.id
      limit 20 offset (select (page - 1) * 20 from paging)
    ), cohort as (
      select p.id, count(s.id) filter (where s.status = 'completed') as completed
      from accounts p left join base s on s.participant_id = p.id
      where p.account_type = 'P' group by p.id
    ), research as (
      select count(*) as participants, count(*) filter (where completed >= 5) as achieved from cohort
    ), usage as (
      select count(*) filter (where account_type = 'P') as p,
        count(*) filter (where account_type = 'T') as t,
        count(*) filter (where account_type is null) as unclassified,
        count(*) filter (where account_type = 'P' and status = 'completed') as completed from base
    )
    select jsonb_build_object(
      'research', jsonb_build_object('participants', r.participants, 'sessions', u.p,
        'completed', u.completed, 'achieved', r.achieved,
        'achievementRate', case when r.participants = 0 then 0
          else r.achieved::numeric * 100 / r.participants end,
        'diaries', (select count(*) from public.diaries d
          join base s on s.id = d.session_id and s.participant_id = d.participant_id
          where s.account_type = 'P' and d.status = 'submitted')),
      'service', jsonb_build_object('sessions', u.p + u.t, 'p', u.p, 't', u.t, 'unclassified', u.unclassified),
      'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.last_activity_at desc, x.id) from recent x), '[]'::jsonb),
      'page', paging.page, 'pages', paging.pages, 'filter', p_filter
    ) from research r cross join usage u cross join paging
  );
end;
$$;

create function public.admin_participants_read(p_page integer default 1, p_filter text default 'all')
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if not coalesce(public.is_active_admin(), false) then
    raise exception 'ADMIN-READ-DENIED: active administrator required' using errcode = '42501';
  end if;
  if p_page is null or p_page < 1 or p_filter is null
    or p_filter not in ('P', 'T', 'all', 'unclassified') then
    raise exception 'ADMIN-READ-INPUT: invalid page or filter' using errcode = '22023';
  end if;
  return (
    with filtered as materialized (
      select id, participant_code, account_type, status, created_at, last_activity_at
      from public.profiles where role = 'participant' and
        (p_filter = 'all' or (p_filter = 'unclassified' and account_type is null) or account_type = p_filter)
    ), bounds as (
      select greatest(1, (count(*) + 19) / 20) as pages from filtered
    ), paging as (
      select least(p_page::bigint, pages) as page, pages from bounds
    ), selected as (
      select * from filtered order by participant_code, id
      limit 20 offset (select (page - 1) * 20 from paging)
    ), rows as (
      select p.*,
        (select count(*) from public.sessions s where s.participant_id = p.id and s.status = 'completed') as completed,
        (select count(*) from public.diaries d where d.participant_id = p.id and d.status = 'submitted') as diaries
      from selected p
    )
    select jsonb_build_object(
      'rows', coalesce((select jsonb_agg(to_jsonb(r) order by r.participant_code, r.id) from rows r), '[]'::jsonb),
      'page', paging.page, 'pages', paging.pages, 'filter', p_filter
    ) from paging
  );
end;
$$;

revoke all on function public.admin_dashboard_read(integer, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_participants_read(integer, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_dashboard_read(integer, text) to authenticated;
grant execute on function public.admin_participants_read(integer, text) to authenticated;
commit;
