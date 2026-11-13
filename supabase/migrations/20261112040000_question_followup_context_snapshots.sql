begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

alter table public.question_followup_requests
  add column supplemental_context_snapshot text not null default ''
  check (char_length(supplemental_context_snapshot) <= 1000);

create function public.snapshot_question_followup_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select revision.context_text into new.supplemental_context_snapshot
  from public.session_context_supplement_revisions revision
  where revision.session_id = new.session_id
  order by revision.revision desc
  limit 1;

  new.supplemental_context_snapshot := coalesce(new.supplemental_context_snapshot, '');
  return new;
end;
$$;

alter function public.snapshot_question_followup_context() owner to postgres;
revoke all on function public.snapshot_question_followup_context()
  from public, anon, authenticated, service_role;

create trigger question_followup_context_snapshot
  before insert on public.question_followup_requests
  for each row execute function public.snapshot_question_followup_context();

commit;
