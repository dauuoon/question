begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table public.question_regeneration_dispatch_metadata (
  attempt_id uuid primary key references public.question_regeneration_attempts(id),
  model_id text not null check (length(btrim(model_id)) between 1 and 200),
  prompt_version text not null check (prompt_version = 'question-regeneration-v1.0'),
  schema_version text not null check (schema_version = 'why_box_question_regeneration_v1_0'),
  validation_version text not null check (validation_version = 'question-regeneration-validation-v1.0'),
  similarity_threshold numeric not null check (similarity_threshold = 0.82),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.question_regeneration_dispatch_metadata enable row level security;
revoke all on public.question_regeneration_dispatch_metadata from public, anon, authenticated, service_role;

create function public.guard_regeneration_dispatch_metadata()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception using errcode='55000', message='Regeneration dispatch metadata is immutable';
end;
$$;
alter function public.guard_regeneration_dispatch_metadata() owner to postgres;
revoke all on function public.guard_regeneration_dispatch_metadata() from public, anon, authenticated, service_role;
create trigger regeneration_dispatch_metadata_immutable
before update or delete or truncate on public.question_regeneration_dispatch_metadata
for each statement execute function public.guard_regeneration_dispatch_metadata();

create function public.authorize_question_regeneration_dispatch(
  p_attempt_id uuid, p_request_id uuid, p_participant_id uuid,
  p_model_id text, p_prompt_version text, p_schema_version text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare acquired boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='Trusted regeneration server required';
  end if;
  if p_model_id is null or length(btrim(p_model_id)) not between 1 and 200
    or p_prompt_version is distinct from 'question-regeneration-v1.0'
    or p_schema_version is distinct from 'why_box_question_regeneration_v1_0' then
    raise exception using errcode='22023', message='Invalid regeneration dispatch provenance';
  end if;
  acquired := public.authorize_question_regeneration_dispatch(p_attempt_id,p_request_id,p_participant_id);
  if acquired then
    insert into public.question_regeneration_dispatch_metadata
      (attempt_id,model_id,prompt_version,schema_version,validation_version,similarity_threshold)
    values (p_attempt_id,btrim(p_model_id),p_prompt_version,p_schema_version,
      'question-regeneration-validation-v1.0',0.82);
  end if;
  return acquired;
end;
$$;
alter function public.authorize_question_regeneration_dispatch(uuid,uuid,uuid,text,text,text) owner to postgres;
revoke all on function public.authorize_question_regeneration_dispatch(uuid,uuid,uuid,text,text,text)
from public, anon, authenticated;
grant execute on function public.authorize_question_regeneration_dispatch(uuid,uuid,uuid,text,text,text)
to service_role;
commit;
