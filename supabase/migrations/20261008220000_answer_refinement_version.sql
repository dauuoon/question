begin;

alter table public.answers
  add column current_answer_version text not null default 'original';

alter table public.answers
  add constraint answers_current_version_check
  check (
    current_answer_version in ('original', 'refined')
    and (
      current_answer_version = 'original'
      or (refinement_used and refined_answer is not null)
    )
  );

grant update (original_answer, refined_answer, refinement_used, refined_at, current_answer_version)
  on public.answers to authenticated;

commit;
