# WHY BOX

WHY BOX is a research tool for supporting designers' reflective thinking. The authoritative v1.0 requirements are in [WHY_BOX_SPEC.md](./WHY_BOX_SPEC.md).

## Production release preflight (2026-10-10)

### Local UI and research export update (2026-10-11)

The UI/export update and its P/T extension are local-only pending review.
Question prompts, AI schemas, existing credentials and research records are
unchanged. The P/T extension requires the draft migration described below;
it has not been executed.

- Successful question generation normalizes the stale wizard status to
  `in_progress`. Answers are immediately editable without refresh. Briefing
  tabs require a completed session **and a successfully loaded saved source**;
  `summary_ready` remains frozen/read-only while completion can be recovered.
  Completion failure preserves the question display and saved/unsaved text.
- Toasts use pill corners. Footer and briefing cancel/save groups use equal,
  intrinsic content-sized columns, with wrapping on narrow screens. Orange
  buttons retain their background on hover and change opacity instead.
- Clicking an image pin opens its question in an orange 90% bubble. Closing
  the bubble retains selection; repeat clicks reopen it. Placement is bounded
  to the image and recalculated for resizing/zoom; long text scrolls inside it.
- The administrator dashboard uses authenticated, paginated DB reads and
  aggregates actual records (no hardcoded research counts).
  Recent activity is the latest stored session/question/answer/diary/image/
  briefing-revision timestamp, not a fabricated session activity field.
  Sorting is activity-descending with stable ID ties, 20 sessions per page.
- Administrator-only XLSX downloads are available on the dashboard (all **P**
  sessions/all **P** diary records including drafts), session details, and participant details.
  The API independently checks the active administrator role and uses the
  authenticated Supabase client and existing RLS, never a service-role key.
  Session workbooks contain Sessions, Questions, Answers, Briefings, Diaries,
  and QuestionEvents sheets. Questions retain all predecessor versions and
  root/parent IDs; briefings retain the AI source and every user revision.
  Diary choices are JSON arrays. Dates are ISO text in Asia/Seoul (`+09:00`).
  Only actual schema fields are exported: `question_kind`, `content_principle`,
  and `detail_type`; no invented question-type field.
- Emails, passwords, auth tokens, API keys, and storage paths are not selected.
  Formula-looking user text is written as an XLSX **string cell**, preserving
  the original content without executing a formula.
- Exports are read-only, not a transactional DB snapshot. Avoid concurrent
  research edits when taking an analysis extract. Streaming XLSX generation
  uses private temporary files, cleaned after completion/cancellation/error.
  Limits: 2,000 selected sessions; 20,000 total data rows; 16 MiB cell text;
  32,767 characters per cell; 4 MiB final file (below Vercel's response limit).
  Limits fail explicitly without truncation: split by participant/session.
  DB reads use 500-row pages, bounded to 50,000 rows/16 MiB per query.
  Dashboard activity aggregation is bounded but server-side in memory because
  the existing schema has no reliable session-level last-activity column.

Offline regressions: `node --test tests/admin-research.test.mjs
tests/question-generation-ui.test.mjs tests/ui-shell.test.mjs`.
Verify full offline tests, lint, typecheck, and build before any approved
deployment; real mobile layout and hosted permissions remain deployment checks.

### Explicit P/T account classification and research policy

- `role` still controls authorization (`admin` / `participant`).
  `profiles.account_type` independently classifies ordinary accounts as `P`
  (research participant), `T` (review/test), or `NULL` (not reviewed).
  Existing rows stay NULL; there is **no backfill to P**, including P01.
  Both P and T use the same participant features. Account codes accept P/T
  prefixes for login convenience, but prefixes never determine classification.
  Changing type does not rename an account or change its Auth identity.
- Creation requires an explicit type selection. Type changes require a
  confirmation checkbox and reason; the checked administrator RPC locks the
  target, compares its expected old type, and records an append-only event.
  It cannot change an administrator, role, password, or session record.
  Ordinary clients retain read-only profile permissions; existing RLS is not
  weakened. A new admin-only RLS policy exposes classification history.
- The main dashboard reports P participants, P created/completed sessions,
  and P submitted diaries. The five-use achievement numerator counts P users
  with at least five **completed** sessions; the denominator is all P users,
  including inactive ones and users with zero sessions. An empty denominator
  is displayed as 0%. The smaller service area reports P+T created sessions,
  separate P/T totals, and unclassified sessions separately. These counts are
  **not API calls or costs**. Recent sessions default to P; filters preserve
  pagination and T/unclassified records remain accessible to administrators.
- All four research XLSX modes require `role=participant AND account_type=P`.
  Direct T/unclassified/admin session or account IDs are rejected with 403,
  not returned as a research file. Empty P scope produces header-only files,
  never test substitutes. Classification is rechecked before finalizing a
  workbook; changes detected during generation fail closed. Extracts are not
  a transaction snapshot: do not reclassify accounts during an analysis export.
  Reclassification applies to **all prior and future records** of the account;
  the audit trail records why the cohort changed, not a per-session type snapshot.
- Draft only:
  [20261011193000_account_type_research_policy.sql](./supabase/migrations/20261011193000_account_type_research_policy.sql)
  adds a nullable classification, code constraint support for T IDs, audit
  events/guards, and the administrator-only change RPC. It must be approved,
  catalog/ACL checked, and applied once **before** deploying this code.
  Missing classification objects produce errors; there is no fallback to
  infer P from old account IDs. No environment flag enables this migration.
- P01 (`ec0bba1e-3720-4200-a5e1-aed0673d2c32`) is the retained E2E account.
  After separate Production approval, confirm project
  `jaqyzbrvufknpsbcuqzw`, protect administrator
  `89507e34-b4fa-464a-b359-316be9a6bdcb`, apply the draft migration once,
  then separately approve renaming this verified NULL/P01/participant row to
  T01 with type T, retaining its UUID and all historical records.
  [classify-e2e-p01.sql](./supabase/operations/classify-e2e-p01.sql) is **not a
  migration**: it requires an explicit project/approval setting, verifies both
  the unchanged Auth rows, administrator and other profiles without printing
  them, checks one new audit event, and defaults to ROLLBACK. The Auth email
  must first be changed by the official Auth Admin API as described below.
  Review and separate COMMIT approval are required. Do not replay it on an
  already classified or renamed row.
  Neither file has been executed against Production/TEST. Isolated execution
  uses only synthetic UUIDs and records as described below.

Offline P/T checks: `node --test tests/account-type.test.mjs
tests/admin-research.test.mjs tests/admin-login.test.mjs
tests/research-minimum.test.mjs`. Hosted Auth/API behavior and current Production
catalog comparison remain pre-deployment gates.

Native isolated validation: `node --test tests/account-type-native.test.mjs`.
Requires `/opt/homebrew/opt/postgresql@17/bin` (fails, never falls back to a remote
database, when missing). It creates a private temporary PostgreSQL cluster with
TCP disabled and a private Unix socket, ignores ambient PG connection settings,
and shuts down/removes only its own temporary cluster. No `.env` file is loaded.
All existing application migrations are reproduced with synthetic Auth/Storage
schemas and accounts. The four account-type SQL files run on that local cluster;
only the operation/preflight/postflight target UUID constants are substituted
with synthetic test IDs. The operation is exercised with its default ROLLBACK
and an isolated COMMIT copy; late migration and profile failures are injected.
Auth email changes/compensation use a local Mock, not an HTTP Auth API.

The native tests verify data/policy preservation, NULL/P/T creation, service-role
profile inserts and audit events, administrator-only RPC, participant/anon
denial, immutable history, row-lock CAS races with two connections, and T01
profile/email/identity collision guards. Completed 4/5-session cohorts are
created through real lifecycle RPCs (not disabled triggers). Actual dashboard
and XLSX code reads the native SQL data through a read-only query adapter;
additional offline export tests cover all four modes, empty P scope and
4/5/6-completion boundaries. Original/regenerated questions, original/refined
answers, briefing source/edit, diary and Storage metadata fingerprints are
compared across conversion. This is PostgreSQL behavior validation, **not**
proof of hosted GoTrue email updates, PostgREST role behavior or image bytes.

Validated locally on PostgreSQL 17.5: 14 native test results (one enclosing test
and 13 scenarios), 55 focused P/T tests, and 347 tests across the 29-file
offline/native regression selection passed with zero failures/skips.
Lint, TypeScript and an offline-credential Production build passed.
The three other native concurrency suites were not part of this selection.
The four reviewed SQL files required no changes after native validation.

### Approval-gated migration and E2E P01 -> T01 runbook

Prepared SQL (not executed):

- [account-type-preflight.sql](./supabase/operations/account-type-preflight.sql):
  read-only identity/collision checks, constraints, indexes, profile ACLs/RLS,
  helper functions, triggers, migration-history availability and data counts.
- [account-type-postflight.sql](./supabase/operations/account-type-postflight.sql):
  read-only column, constraints, audit RLS/ACLs, RPC permissions, triggers,
  protected admin and renamed account checks.

**Backup and stop conditions.** Confirm the actual dashboard/connection project
is `jaqyzbrvufknpsbcuqzw`; a SQL approval setting is not project identity proof.
Keep All Deployments protection and stop participant/account writes, uploads,
automatic retry scripts and type changes. Have the operator verify a usable
Supabase backup/PITR restore point and its timestamp before approval. Keep a
private baseline of schema/RLS/ACLs, all account and app records, Auth identity
and password-hash comparisons, and Storage paths/counts. Never print credentials
or commit the backup. Database backups do not contain Storage object bytes:
verify an independent image backup if byte-level recovery is required.
Record migration SHA-256, row counts and the retained E2E session/image IDs.
Do not treat the old empty-database reset snapshot as the current recovery point.

Stop if T01 exists as a profile code, Auth email or email-provider identity;
if P01 UUID, code, role, status or Auth email differs; if the admin differs;
if the new migration is already/partially present; or if there are unexpected
schema/policy changes. Inspect migration history separately when its table
exists. Do not use an unreviewed bulk `db push` to replay earlier applied SQL.
Before applying this migration, `authenticated` must retain SELECT-only
profiles access, `anon` no profile writes and `service_role` its existing
administrative privileges. A column-level REVOKE does not cancel unexpected
table-level/inherited UPDATE grants: stop and resolve such drift separately.

**Migration checks.** Apply the one approved file in its transaction, with
5-second lock / 60-second statement timeouts; a timeout/error rolls it back.
Immediately after COMMIT, existing accounts must still have NULL account_type,
new audit history must be empty, and preexisting data/counts/admin/Auth unchanged.
The nullable text column has no default. The only replaced constraint is the
P/T code-format check; role/code constraint, case-insensitive unique index and
UUID foreign keys remain. The new audit table has RLS enabled, admin-only SELECT
for authenticated clients and no client DML/TRUNCATE privileges. Only
authenticated clients can execute the change RPC; its active-admin check denies
participants (an EXECUTE grant is not admin authorization). Internal trigger
functions have no client EXECUTE grants. Type changes are row-locked, CAS checked
and atomic with their audit insert. An unchanged type returns false without an
event; clearing a classified type is rejected. SQL-operator changes have a NULL
actor, whereas authenticated-admin RPC changes record the admin UUID.
Audit FK RESTRICT/immutability intentionally prevents later deletion of classified
accounts or audit actors; any future deletion policy needs a separate design.

**Renaming is a two-system operation, not one atomic SQL transaction.**
The login action maps P01 to `p01@participants.whybox.invalid` and T01 to
`t01@participants.whybox.invalid`; it does not look up profiles by code.
The application owns `profiles.participant_code`; Auth owns the login email.
UUID-based authorization, sessions/FKs, image paths and ownership remain unchanged.

1. Apply/verify the migration, then deploy the separately approved P/T-capable
   code while access protection remains enabled. The old deployed build may
   reject T01: do not switch the account before a verified compatible release.
2. Repeat preflight/collision checks immediately before the operation; capture
   a private baseline for Auth password/role, profile fields and app records.
3. With separate account-change approval, call the server-only official API
   `auth.admin.updateUserById('ec0bba1e-3720-4200-a5e1-aed0673d2c32',
   { email: 't01@participants.whybox.invalid', email_confirm: true })`.
   Omit password, role, metadata and other attributes. Do not update auth.users
   or auth.identities with SQL. Check error, returned UUID and verified email;
   compare password hash/authorization to the private pre-API baseline.
   Provider-maintained email/identity fields and updated_at may change.
4. The profile SQL requires this confirmed new Auth email, locks profiles,
   rechecks collisions and changes exactly that old P01/NULL/active participant
   to T01/T. It verifies other profiles and Auth rows unchanged within this
   SQL stage and allows only code/type/profile updated_at to change.
   Choose COMMIT only in a separately approved copy of the default-ROLLBACK
   script. A rehearsal ROLLBACK does **not** revert an already changed Auth email.
5. Compare all original app rows, FKs and Storage paths/bytes with the baseline;
   run postflight. Authenticate as T01 with the unchanged password and confirm
   the same UUID; old P01 must fail on a fresh login (no old-code alias is added).
   Verify admin login, participant history, image, session detail, admin detail,
   T recent-session filter, research counts and all four research exports.
   The former E2E account must be excluded from P statistics/exports, included
   in T service counts and remain viewable by admins. Do not generate AI calls
   or new sessions for this verification. Existing tokens may keep their UUID
   authorization until logout/refresh; close the P01 test tabs beforehand.

**Failure recovery.** A migration error before COMMIT requires no inverse SQL:
stop, verify rollback and diagnose. If COMMIT status is uncertain, query objects
and history, not blind replay. After successful COMMIT, prefer fixing forward
under separate approval; do not drop classification/audit data or disable
history triggers. A provider restore affects the entire project and requires
a separate outage/restore approval, not an automatic response to this migration.

If the Auth API result is uncertain, read back the exact UUID before retrying.
If it fails, do not run profile SQL. If Auth succeeded but profile SQL failed or
rolled back, keep the maintenance window, verify the unchanged P01 profile, and
compensate the email to `p01@participants.whybox.invalid` through the same Admin
API after reviewing collisions; preserve password/UUID. Verify both systems,
then retry only after diagnosing the error. If the profile COMMIT succeeded,
do not pretend a type-clear rollback is possible: the immutable history and
NULL-clear guard require a separately approved repair plan. A code-only rename
back to P01 with type T and Auth email compensation is possible after review;
reverting classification to NULL would violate the audit policy.

Reference: [Supabase Auth Admin updateUserById](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid).
All runtime RPC/trigger tests, account updates, deployment, history registration
and recovery operations remain separately approval-gated.

### Administrator login alias

Set server-only `WHY_BOX_ADMIN_AUTH_EMAIL` to the existing administrator's Auth
email to accept `admin` (case-insensitive, surrounding whitespace ignored) on the
login screen. Never commit the value or expose it with `NEXT_PUBLIC_`. Configure
it for Vercel Production only, not Preview with Production account information.
The alias does not change Auth users, passwords, profiles or roles: Supabase still
checks the password and the authenticated UUID's active profile determines access.
Existing email and `P01` participant logins are unchanged. Missing/invalid alias
configuration reports `AUTH-004` without attempting authentication; other login
formats remain available. Configuration and deployment require separate approval.

**Local implementation and offline validation complete; remote release still approval-gated.** A successful build does not verify the
hosted database, live AI behavior, or the complete participant journey.
GitHub push, Production DB/Auth/Storage changes, Vercel deployment/deletion,
TEST cleanup, and actual OpenAI calls require separate explicit approval.
The target repository is `https://github.com/dauuoon/question.git`; use a new
Vercel project, not the existing old `whybox` project.

### Verified locally and read-only

- At the start of preflight, this directory had no Git repository. The target
  GitHub repository returned no refs or HEAD (`ls-remote` succeeded; querying
  HEAD with `--exit-code` returned 2), so there is no remote code/branch to
  compare or merge. Initial import is required; do not describe this as synced.
  Local Git was then initialized on `main` and `origin` set to that URL only;
  no files were staged, committed, or pushed.
- An isolated copy passed the exact `npm run build` with Next.js 16.3.8 and
  Node.js 24.3.0, using placeholder Supabase credentials and no OpenAI key.
  Lint/typecheck passed. 23 offline suites passed all 276 tests; three native
  PostgreSQL suites were excluded, not verified by this run.
  The isolated production server returned HTTP 200 for `/login` and redirected
  unauthenticated `/`, `/history`, and `/admin/participants` to `/login`.
  This smoke test did not authenticate or exercise hosted research data.
- Production REST OpenAPI and image-bucket metadata were read with GET only,
  without reading participant rows. `.env.local` targets Production project
  `jaqyzbrvufknpsbcuqzw`; the isolated TEST runtime targets
  `njtgxnlxlhxpbiekbgmv`. Neither private environment file was modified.
- Production exposes the baseline research, upload reservation, image deletion,
  question generation, answer-version, and question-action API objects.
  `why-box-images` is private, permits JPEG/PNG, and has a 10 MiB limit.
  This is API-catalog evidence, not verification of function bodies, triggers,
  RLS/ACLs, or SQL migration-history registration.

### Local fixes and remaining deployment gates

1. **Live briefing is now implemented locally.** Production selects the OpenAI
   provider only with `OPENAI_SESSION_BRIEFING_ENABLED=true`, a key and an
   explicitly configured `OPENAI_SESSION_BRIEFING_MODEL`. TEST keeps its restricted
   Mock. Disabled/missing live configuration returns `BRIEFING-CONFIG` before
   freezing the session. No model access or actual generation has been verified.
2. **Three migrations need remote reconciliation.** Production's API catalog
   does not expose the regeneration or briefing objects introduced by:
   - [20261010001500_question_regeneration.sql](./supabase/migrations/20261010001500_question_regeneration.sql)
   - [20261010002000_regeneration_dispatch_provenance.sql](./supabase/migrations/20261010002000_regeneration_dispatch_provenance.sql)
   - [20261010003000_session_completion_briefing.sql](./supabase/migrations/20261010003000_session_completion_briefing.sql)
   The local direct-upload implementation additionally requires
   [20261010235000_verified_direct_image_upload.sql](./supabase/migrations/20261010235000_verified_direct_image_upload.sql);
   it has not been applied to either remote environment.
   Nine corresponding zero-row table GETs returned 404 / `PGRST205`; no
   participant rows were fetched. Missing/stale API schema is confirmed, but
   physical table absence and migration history still require SQL-catalog access.
   Confirm the actual PostgreSQL catalog and existing migration history before
   applying only approved missing changes, in timestamp order. Do not blindly
   replay earlier SQL Editor migrations or run remote `db reset`/`db push`.
3. **Direct Storage upload now bypasses Vercel's incoming body limit.**
   The browser sends the entire image to Supabase Storage, not a Vercel Function.
   The app endpoint accepts at most 4096 bytes of JSON for reserve/finalize;
   [Vercel Functions limit request/response payloads to 4.5 MB](https://vercel.com/docs/functions/limitations#request-body-size).
   The server downloads the reserved object internally to verify it. The 10 MiB
   and ten-image policies are unchanged. Remote Storage/browser verification
   remains required after approved migration rollout.
4. **The minimum is now five completed sessions.** The spec and Admin status
   use `MINIMUM_COMPLETED_SESSIONS=5`, with no upper usage limit. Every completed
   session still supports its own diary. No existing record is changed.

### Implementation validation (local only)

- The final implementation passed `npm run lint`, `npm run typecheck`, and
  the exact `npm run build` in an isolated source-identical copy with placeholder
  Supabase configuration and no real OpenAI credentials.
- All 290 tests across 25 offline test files passed. Coverage includes mocked
  OpenAI request/output/error handling, Production completion mode and UI,
  disabled configuration before any completion mutation, atomic completion and
  retry regressions, exact 10 MiB byte verification, direct-upload recovery,
  PGlite SQL/RLS ownership/overwrite/finalization/generation locks, deletion
  recovery, and Admin minimum boundaries at 4/5/6/10 sessions.
- Three native PostgreSQL concurrency/provenance suites were excluded:
  `question-generation-concurrency`, `question-regeneration-concurrency`, and
  `question-regeneration-provenance-native`. PGlite tests do not substitute for
  hosted Storage checks or native multi-connection concurrency verification.
- The isolated Production smoke test returned 200 for `/login` and redirected
  unauthenticated `/`, `/history`, and `/admin/participants` to `/login`.
  It did not log in, contact a real Supabase project, or invoke AI.
- Checksums confirm both private environment files and the existing initial/
  regeneration question prompts and schemas are unchanged. No remote migration,
  data write, GitHub push, Vercel deployment, live OpenAI call or TEST cleanup
  was performed during this implementation.

### Grounded live briefing contract

- The durable database completion snapshot supplies confirmed design context and
  active answered slots with the final selected answer version. The provider
  checks that each selected answer matches its original/refined version, then
  sends only `participant_confirmed_context` and `final_answers`.
- Session/participant/question UUIDs, question text, superseded answer versions,
  skipped questions, images and prior AI drafts are not sent to OpenAI.
- The separate [briefing prompt v1.4](./src/lib/ai/prompts/session-design-briefing-v1.4.ts)
  asks for natural first-person Korean prose from the designer's perspective,
  prohibits third-person participant summaries and invented intentions,
  judgments, facts or causal links, and preserves uncertainty/negation. It uses
  professional client-facing `~습니다` prose and distinguishes intentions,
  judgment grounds and review targets without upgrading wishes into confirmed
  plans, ongoing work or completed results. Briefing output still uses
  the strict v1.0 JSON schema; the prompt version is stored with each new source.
- Calls use `store:false`, no tools, no streaming, 4000 output tokens, a 45-second
  deadline and SDK retries disabled. Only a complete, non-refusal, single-message
  validated output is accepted; the returned model and prompt/schema versions
  are persisted with the immutable source.
- Source save and session completion remain atomic in the existing DB RPC.
  Same-request replay never redispatches. One explicit retry is allowed after a
  definitive failure; connection/timeouts/5xx with uncertain delivery are
  `dispatch_unknown`, not automatically retried. Source revisions remain CAS.
- Prompt constraints and JSON validation cannot mathematically guarantee absence
  of semantic hallucinations. This run validates wiring and grounding payloads
  with mocks only; live model quality/access evaluation requires separate approval.

### Direct upload security and rollout contract

1. Before reserving, the browser checks size/type/name, file signature and local
   image decode to avoid consuming slots for ordinary corrupt/mislabeled files.
   These are UX checks, not trusted verification. The same-origin JSON reserve request verifies an active owning Participant,
   editable session, absence of questions and the new migration capability.
   It reuses `reserve_image_upload` and server-derived immutable
   `participant/session/request-sha256.ext` paths; caller paths are rejected.
2. The browser uses its ordinary Supabase Auth session and publishable key for
   `Storage.upload(..., upsert:false)`. No service-role key, signed upload URL,
   public bucket or RLS-bypassing upload token reaches the browser. Private
   bucket limits, ownership, immutable ten-slot reservations, generation locks
   and deletion tombstones remain enforced by existing RLS/DB guards.
3. Finalize reauthenticates, resolves the same reservation and downloads that
   exact object with the Participant's RLS client. It checks actual byte size,
   SHA-256, Sharp format/dimensions and full decode before using the server-only
   `finish_verified_image_upload` RPC. That RPC locks/rechecks session, active
   profile, reservation, Storage metadata and deletion/generation state before
   inserting metadata, or returning an identical replay without a second insert.
4. The additive migration revokes browser INSERT/UPDATE on `session_images` and
   adds a restrictive Storage UPDATE denial for this bucket. This prevents
   metadata-validation bypass and post-verification overwrite, including upsert.
   SELECT/private previews and approved deletion/recovery remain unchanged.
5. Lost reserve/upload/finalize responses retain the request and path. Duplicate
   object uploads are verified, not overwritten. Failures retain reservations
   and objects, never use destructive compensation. Invalid stored bytes fail
   explicitly and retain their reservation for operator investigation; ordinary
   retries never allocate another slot for the same request.
6. This changes the upload API from multipart to reserve/finalize JSON. Pause
   uploads during coordinated DB/app rollout; old clients lose metadata-write
   privileges. Do not enable the new client on an old schema: capability checking
   fails closed. No data backfill, deletion or research-table rewrite is needed.

### New Vercel project configuration

Select Next.js, repository root, `npm ci`, `npm run build`, Node.js 24.x, and a
function configuration that supports the route durations (up to 120 seconds).
Production variables are:

| Variables | Scope / requirement |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Production project; browser-public; fixed at build time |
| `SUPABASE_SERVICE_ROLE_KEY` | Matching Production project; server-only secret |
| `OPENAI_API_KEY` | Server-only secret; actual calls require separate approval |
| `OPENAI_CONTEXT_DRAFT_ENABLED`, `OPENAI_CONTEXT_DRAFT_MODEL` | Independent optional context-draft provider |
| `OPENAI_SENTENCE_REFINEMENT_ENABLED`, `OPENAI_SENTENCE_REFINEMENT_MODEL` | Independent optional sentence-refinement provider |
| `OPENAI_QUESTION_GENERATION_MODEL` | Required for live initial questions; no separate enable flag |
| `OPENAI_QUESTION_REGENERATION_ENABLED`, `OPENAI_QUESTION_REGENERATION_MODEL` | Enable only after migration and provider approval |
| `SESSION_IMAGE_DELETION_ENABLED` | Independent flag; check pending deletion recovery before changing |
| `OPENAI_SESSION_BRIEFING_ENABLED`, `OPENAI_SESSION_BRIEFING_MODEL` | Live briefing enable flag and approved model; disabled/empty in example |
| `SESSION_BRIEFING_MOCK_ENABLED=false` | TEST Mock must remain disabled in Production |

Do not copy `.env.local` wholesale: its Context Draft and Sentence Refinement
flags are currently enabled. Do not put service-role/OpenAI keys in
`NEXT_PUBLIC_*` variables. Do not give Vercel Preview branches Production
credentials; keep Preview disconnected until a separate environment is approved.
Keep `SUPABASE_TEST_*`, `WHY_BOX_TEST_*`, `WHY_BOX_RESEARCHER_*` and local budget
paths out of Vercel Production. `NODE_ENV` is managed by Next.js/Vercel.

### Approval-gated execution order

1. Review the local live briefing, direct-upload and five-use implementations;
   rerun build/typecheck/lint and offline regressions. Review the initial
   Git file list: only source, migrations, tests, lockfile and docs belong in Git.
   Environment files, logs, `.next`, `.test-runtime`, `.qrpg-*`, Supabase CLI
   cache and generated database data must remain ignored. Review/commit the
   release candidate locally, then push to GitHub **only after push approval**.
   Do not connect an auto-deploying Vercel project before DB readiness.
2. After separate **Production DB approval**, take an appropriate backup,
   compare catalogs/history and data-integrity baselines, and apply only missing
   approved migrations in order. Verify required RPCs/tables, RLS/ACLs, private
   Storage, retry behavior and preservation of existing research records.
   Do not drop history tables or bypass retention guards as a rollback shortcut.
3. After separate **Vercel deployment approval**, create/import the new project,
   select the approved Git revision and environment variables, configure Supabase
   Auth Site URL/allowed redirects for the new domain under appropriate approval,
   and deploy. Keep Preview isolated. Verify login/roles, upload boundaries,
   recovery, question/answer actions, completion, briefing revisions and diaries;
   any actual AI requests need their own explicit authorization and call budget.
4. Keep both the old Vercel project and all TEST projects/data until the new
   release succeeds and retention/cleanup is separately approved.

## Local first-pass performance optimization

- Role verification uses React `cache` for the current server render only.
  Layout and page reuse one verified Auth user and active profile; expected-role
  checks still run at every call. No shared user cache or proxy-trusted headers
  are used. Proxy cookie refresh and its Auth check remain independent because
  proxy and server rendering do not share a React request cache.
- Session entry passes its already ownership-filtered session snapshot to the
  generation reader. Snapshot UUID/owner/status/count validation remains
  fail-closed. Independent attempt/question queries, image/target/capability
  queries, and answer/signed-URL work run in parallel. Active-version, answer,
  pin, recovery and completed-only briefing checks remain unchanged.
- Admin reads use `public.admin_dashboard_read(integer,text)` and
  `public.admin_participants_read(integer,text)`, with `p_page` and `p_filter`
  arguments and 20 rows per page. The dashboard returns P-only research counts,
  five-completion achievement, separate P/T/unclassified usage, and recent
  activity/progression in one consistent SQL statement. Participant counts no
  longer issue two queries per account. Filters and page clamping run in the DB;
  the app does not download whole history tables for dashboard aggregation.
  Both STABLE security-invoker RPCs require an active admin and retain existing
  RLS. EXECUTE is granted to authenticated only, not anon or service_role.
- Draft `supabase/migrations/20261011220000_admin_read_performance.sql` must be
  reviewed and separately approved before any Production use. Apply after the
  existing schema/RLS chain (including participant activity and completion
  objects) and `20261011193000_account_type_research_policy.sql`. The new file
  creates read functions only; it does not change accounts, research rows,
  tables, RLS, Auth or Storage. Missing RPCs fail explicitly; there is no silent
  full-table fallback. Coordinate DB readiness before deploying these callers.
  P01/T01 conversion remains a separate approval, not a prerequisite to testing
  the RPCs with synthetic data. Excel export policy and history remain intact.
- Optional server-only `WHY_BOX_PERFORMANCE_LOG_ENABLED=true` instruments the
  SSR Supabase client's outgoing HTTP requests. Default is off. Each record
  contains a random correlation ID, `proxy` or `server` scope, category
  (`auth`, `db`, `storage`, `other`), response-header duration, category count,
  cumulative duration and failure boolean. It never records URLs, request
  headers/bodies, user/session UUIDs, credentials, or response/research text. Proxy and
  render IDs are deliberately separate; route handlers without a React render
  cache get their own client-local metrics. Parallel durations must not be
  added to estimate page wall time. These are HTTP timings, not SQL execution
  time or OpenAI provider timings. Enabling Production logs needs separate
  environment/deployment approval and an appropriate log retention policy.
- `node --test tests/request-performance.test.mjs` checks real Next RSC
  request-cache isolation and compares the same synthetic session fixture
  against the previously deployed reader. Simulated network latency is clearly
  labeled and is not a Production speedup guarantee. No real Supabase or
  OpenAI calls are made.
- `tests/account-type-native.test.mjs` validates the draft admin RPCs on a
  disposable PostgreSQL cluster using a private Unix socket. It checks RLS and
  admin-only access, stable pagination/activity, unchanged data hashes,
  migration rollback, and native dashboard/Excel data parity. Its benchmark
  adds synthetic accounts/sessions inside a rolled-back transaction. `psql`
  timing includes statement execution, result serialization and local client
  roundtrip overhead (not connection startup); it is not pure SQL execution
  time, Production HTTP latency, or a statistical performance guarantee.

## Phase 1 foundation

- Next.js App Router with Participant and Admin route groups
- Supabase Auth/SSR client helpers and role-protected layouts
- Participant-code sign-in mapping to a non-routable internal Auth email
- Ten research tables, integrity constraints, and RLS migrations
- Private image bucket policies
- Participant-safe error catalog and server-only internal error logging
- Shared light-theme Design Tokens and global control styles

The sections below are historical implementation notes. Features excluded from
Phase 1 may have been implemented later; use the release preflight above for
current deployment readiness.

## Local setup

1. Install Node.js 20.9 or later and the Supabase CLI.
2. Install dependencies with `npm install`.
3. Start the local Supabase stack with `supabase start`.
4. Read the local API URL and keys from `supabase status`. Copy `.env.example` to `.env.local` and set the local URL, publishable key (or local anon key), and server-only service-role key.
5. Apply the local-only migrations to the local database with `supabase db reset`.
6. Run the app with `npm run dev`.

The Phase 1 migrations have been applied to the approved WHY BOX Supabase project through SQL Editor, schema then RLS in one transaction. Do not run them again on that project. Reconcile CLI migration history before adopting CLI-based remote migration workflows.

## Initial Admin bootstrap

Create exactly one Admin Auth user directly in the Supabase Dashboard. After the Phase 1 schema has been applied to the intended project, use the SQL Editor with the Auth user's UUID to create its profile:

```sql
insert into public.profiles (id, role, status)
values ('<AUTH_USER_UUID>', 'admin', 'active');
```

Do not expose the Supabase service-role key to the browser or use a public self-registration path to grant roles. Participant accounts are created from authenticated Admin-only server actions on `/admin/participants`.

## Participant login identity

### Researcher-only TEST sentence refinement

`scripts/prepare-refinement-fixture.mjs --create` provisions one explicitly approved
synthetic fixture in TEST only. Do not rerun provisioning when its manifest exists.
The fixture is identified in Auth metadata and the private
`.test-runtime/researcher-refinement.json` manifest; temporary login details are in
`.test-runtime/researcher-refinement-login.txt`. Never commit or share that password.
The preparer follows the normal participant RLS draft/context/image/answer paths
and stages synthetic question candidates without an AI request. Immutable fixture
history is retained; it does not delete existing research data.

The ordinary `npm run dev:test` keeps all external AI disabled. After **separate
explicit approval** for live calls, stop only the TEST listener and use
`npm run dev:test -- --refinement-researcher --approve-live-refinement`.
Without the approval flag, researcher mode remains AI-disabled. The live mode
validates the marked Auth user, session ownership/state and fixed budget policy,
then scopes the refinement route to that user/session inside the isolated TEST
snapshot. It never changes the Production runtime or environment files.

The new researcher budget is **three calls total**, not per question or restart.
Exclusive durable markers in `.test-runtime/researcher-refinement-budget/` consume
the budget before provider I/O; errors, timeouts and crashes do not restore it.
Do not remove markers or reset the policy. Old one-call E2E records are untouched.
Input is limited to 1,200 characters and output to 800 tokens, with SDK retries
disabled and prompt v1.1 unchanged. Other AI features remain disabled; briefing
stays Mock. `/api/test-environment` reports the live mode and remaining call count.
Existing original/refined answer storage and original restoration are reused.

Validate offline with
`node --test tests/test-runtime.test.mjs tests/test-refinement-budget.test.mjs tests/researcher-refinement.test.mjs`.

Participants enter their participant code (for example, `P01`) and temporary password. The server maps the normalized code to an internal address under `participants.whybox.invalid` for Supabase email/password authentication. The address is non-routable and must never be shown to participants or sent as account contact information. Account provisioning uses `email_confirm: true` on the server; it does not depend on disabling email confirmation globally. Keep public sign-up disabled in Supabase.

The Admin signs in with the Admin Auth email and password. Participant password reset and account provisioning must use authenticated server-side Admin operations; the service-role key is never sent to the client.

Invalid or reused refresh tokens (including HTTP 400 Auth responses) require sign-in
again, not a runtime-error screen. The proxy preserves Supabase's session-cleanup cookies,
and protected layouts redirect to `/login?error=AUTH-005` with a safe re-login message.
Transport/server errors remain explicit failures; they are not treated as session expiry.
Validate this distinction with `node --test tests/auth-session.test.mjs`.

## Phase 2 accounts and images

- `/admin/participants`: create code/password accounts, activate/deactivate accounts, reset temporary passwords, and view cumulative completed-session/submitted-diary counts. Five completed sessions is a minimum, not a cap.
- `/sessions/new`: start a persisted draft. `/sessions/[sessionId]`: JPEG/PNG picker, drag/drop, clipboard paste, private previews, and explicit failed-upload retry.
- Each file is limited to 10 MiB (matching the existing DB/bucket limit), with at most ten registered images per session enforced by the UI, upload endpoint, and DB metadata guard. The server validates actual image format and metadata with Sharp, checks ownership and active role, and uses the participant's RLS-protected Supabase client for Storage and metadata writes.
- The browser sends image bytes directly to private Supabase Storage rather than through a Vercel Function. Up to three files are verified/reserved/uploaded/finalized concurrently; each retains its original reservation ID for safe retry. Initial image-list restoration and active upload work show inline status instead of a global toast.
- Upload and metadata insertion are separate services, not a DB transaction. The local reservation-aware implementation keeps a failed upload's immutable reservation and any verified object for same-path retry; it never deletes an object after an ambiguous DB response or while another request could finalize it. Partial failures are explicitly logged, not reported as success. No existing image is overwritten or deleted.
- Signed previews expire after five minutes. Refresh the image list to renew them. Delete/replace/reorder controls and design-context input remain future work; AI generation is not connected.
- Provisioning errors record safe operation/error codes, never passwords, internal email aliases, or raw Auth responses. Next.js incoming request logging is disabled to avoid logging IDs in session URLs.
- TEST codes should use an unmistakable reserved-looking numeric suffix (for example `P990000001`) and be shown as test data in operator notes. No test account is created automatically by the application.
- Persisted research sessions cannot be deleted under the current retention guards. Live TEST sessions remain unless separately approved cleanup is designed; do not disable guards or replay migrations to remove them.
- Live checks verified account creation/code login/password reset, inactive-account denial, picker/drop/paste, own private previews/downloads, cross-participant denial, and format/size/registered-image limits. Two approved TEST accounts were deactivated; their two draft sessions and eleven registered images remain as TEST data.
- The currently deployed Storage policies do not cap unregistered objects. A test-only eleventh object was removed immediately. The additional reservation migration below is local-only and has NOT changed deployed schema/RLS.

## Local-only Storage reservation migration

[20261003233000_storage_upload_slots.sql](./supabase/migrations/20261003233000_storage_upload_slots.sql) adds one technical table; the ten research tables remain unchanged.

- Each session has immutable slots numbered 1 through 10. Slot PK/CHECK constraints bound the number of authorized object paths, rather than relying on an RLS `COUNT` with a concurrent-insert race.
- `reserve_image_upload(session_id, request_id, extension, content_sha256)` returns one row containing `storage_path`, `slot_index`, and `sort_order`. It authenticates an active owning Participant, locks the session, checks editability, and reserves an unused slot. The extra sort order preserves existing image ordering and avoids API requests assigning the same metadata order concurrently.
- The SHA-256 is computed server-side and bound into the immutable path. Reusing a request ID with different bytes or format is rejected. Retries reuse both request ID and file, and uploads always use `upsert: false`.
- Direct authenticated INSERT/UPDATE is allowed only at an exact reserved path, in addition to ALL existing permissive ownership/state conditions. SELECT, DELETE, Admin reads, and existing research-table RLS are unchanged. The helper reads only application tables; it does not recursively query `storage.objects` in its policy.
- The technical table has RLS enabled and no direct client/service-role table grants. Only authenticated users receive EXECUTE on the reservation/helper functions; the functions use `SECURITY DEFINER`, a fixed empty search path, a fixed `postgres` owner, and explicit owner/role checks. Reservation UPDATE, DELETE, and TRUNCATE are guarded.
- Service Role still bypasses Storage RLS. It is not made subject to a ten-object database quota by this migration. Existing account management/error logging remains unchanged. Any future trusted-server upload/copy/move must separately follow the reservation contract; no service-role upload RPC is introduced here.

### Backfill and application order

The migration runs inside `BEGIN`/`COMMIT` with bounded lock/statement timeouts. It requires the migration operator to have the existing Storage policy/locking privileges and ability to set ownership to `postgres`.

1. Pause uploads, including direct clients and trusted-server jobs; drain in-flight Storage requests. A table lock alone cannot stop provider-side requests outside the DB transaction.
2. Apply only the new migration after approval. It locks existing application rows/tables and Storage metadata, builds the distinct union of object and image paths, and rejects malformed paths, missing/wrong participant/session relations, more than ten paths per session, orphan objects, missing objects, and MIME/size mismatches. Any exception rolls back the complete migration. No Storage metadata/object is directly inserted, updated, deleted, or renamed by SQL.
3. Backfill existing paths with deterministic slots ordered by original image sort order/path; retain original image sort order, IDs, names, and bytes. Deactivated TEST owners are valid for backfill (not for new reservations).
4. Deploy the reservation-aware API AND uploader before reopening uploads. Deploying either the restrictive policies with the old API, or the new API against a database without the RPC, will fail uploads intentionally; there is no insecure fallback. Do not replay the two previously applied migrations.

Based on the last completed live test, the expected backfill is eleven slots across two TEST sessions (ten and one). This is an expectation, not a fresh remote-data verification. Unexpected unmatched objects/rows or missing Storage `metadata.size`/`metadata.mimetype` cause a fail-closed rollback, requiring operator investigation rather than automatic deletion.

### Retry and recovery boundaries

The browser supplies a UUID per selected file and retains it for the retry button during the current page lifetime. After a lost response, refresh reconciles already saved image IDs and excludes those from retry/count checks. The API checks for an existing matching image, verifies existing object bytes on duplicate/replayed requests, and inserts metadata once with the reserved sort order. A concurrent duplicate metadata INSERT is reconciled by reading the same path, not by blindly deleting the object.

Invalid files consume no reservation. Storage failures keep the reservation. Metadata failures can leave a bounded, not-yet-registered object for the same request to finalize on retry. This is recoverable partial state, not cross-service atomicity. Reservations are never automatically expired, released, or assigned to a new path. A page reload loses its pending File/request ID; the operator must investigate an abandoned reservation/object. Deletion, replacement, and slot recycling require separately reviewed recovery workflows; this change does not implement those UIs.

### Local validation and post-approval tests

Run `npm run lint`, `npm run typecheck`, `npm run test:storage-slots`, and `npm run build`. The tests check local retry/limit behavior, the actual API handler against mock-only Supabase clients, and SQL-text invariants, NOT PostgreSQL execution or actual concurrent Storage requests. They never load Supabase environment values or call external services. `test:storage-slots` requires Node 22.6+ with type stripping (the development environment uses Node 24).

After approved application, test:

- Valid and invalid backfills with complete transaction rollback on failure, including ten/eleven paths, orphan/missing objects, bad owner/session, and metadata mismatch.
- Existing TEST previews/IDs/order and the unchanged SELECT/DELETE/role protections.
- Own reserved uploads, foreign/unreserved path denial, inactive/frozen denial, copy/move/upsert attempts, and an unchanged unrelated bucket.
- Concurrent reservations at nine/ten slots and concurrent same-request uploads/retries; verify slots, object paths, and image rows separately.
- Picker/drop/paste and exact/over 10 MiB, PNG/JPEG, ten/eleven limits.
- Upload failure, lost upload/DB response, duplicate finalization, content mismatch, retained reservation recovery, and no deletion of a successfully finalized object.
- Admin and Service Role reads/cleanup/account management/error logging, with the Service Role bypass explicitly distinguished from authenticated-client guarantees.

## Local-only Participant recent activity

[20261004150000_participant_last_activity.sql](./supabase/migrations/20261004150000_participant_last_activity.sql) adds nullable `profiles.last_activity_at` with no historical backfill. It has NOT been applied remotely; the Storage reservation migration is also still unapplied. The Admin account list now requires this column, so until approval/application the updated list will show its safe error boundary rather than fabricate activity dates.

`recordParticipantActivity()` is server-only: it verifies the Auth user and active Participant profile, derives the ID itself, and calls a Service-Role-only RPC. The RPC supplies `clock_timestamp()` and atomically writes only when NULL or older than five minutes. Authenticated/anonymous users cannot execute it or update the column under existing grants/RLS. Admin account changes and automatic profile `updated_at` changes do not count as Participant activity.

Successful page components mount an activity marker for home/history/new-session/owned-session screens. Only visible, committed navigation emits a same-origin event; prefetch, API list/preview requests, RSC rendering/refresh, hidden-page loads, and repeated same-path mounts do not. Full document reloads are conservatively excluded (manual and automatic reloads cannot reliably be distinguished). There is no timer, visibility heartbeat, or background polling. Navigation events are also coalesced for five minutes in browser memory; the DB condition is the authoritative cross-tab/concurrent limit. This is a five-minute-granularity recent-use date, not an exact audit trail. A browser signal is not proof of human input: an active owner can replay valid screen events, but cannot choose a date or affect another account.

Session creation and successful image finalization call the same recorder only after saving succeeds. Future answer/diary handlers can call it after their successful save; those features are not implemented. Recording failures are logged with `SAVE-002`; upload success includes `activityRecorded` and displays a warning when false, while a successful session creation redirects with an activity warning. Previously saved research data is not rolled back because analytics recording fails. Admin dates use the same `ko-KR`/`Asia/Seoul` formatter for creation and recent use; NULL displays `사용 기록 없음`.

Reservations, failed uploads, authentication itself, Admin access, and failed/not-found research routes do not record activity. Activity endpoint validates an allowlisted route and, for session pages, the current authenticated owner's session. The endpoint has no date/participant-ID input.

Validate locally with `npm run test:activity` (mock-only, no Supabase calls), existing upload tests, lint, typecheck, and build. After approved application, verify NULL display, active-owner writes, server timestamps, cross-tab throttle, inactive/Admin denial, same-route refresh/prefetch exclusion, owned-session navigation, save-failure exclusion, record-failure warnings, and Korean date boundaries.

## Phase 3-A session input

Participant session pages now load and autosave design category/subcategory, work stage,
up to three reflection contexts, and optional editable work context. Existing stable IDs
are reused. Incomplete drafts are allowed; changing the primary category clears the
subcategory and other-category text. Work context is limited to 1,000 Unicode code points
(including spaces/newlines), with a visible counter and a one-second typing debounce.
Selections debounce for 200 ms. Saves are serialized, identical values are skipped, and
failures retain input with an explicit retry. Browser-close/reload and ordinary link
navigation warn while unsaved. Confirmed navigation can discard pending edits; abrupt
browser/process termination and programmatic/history navigation cannot guarantee a flush.

[20261005190000_session_context_save.sql](./supabase/migrations/20261005190000_session_context_save.sql)
was applied to the approved WHY BOX project through SQL Editor after explicit approval.
The exact migration and installed function-body hashes were checked. Do not replay this
or the older migrations; SQL Editor application does not register CLI migration history.
Missing/unavailable RPCs report `SAVE-001`, never partial multi-request writes.
The function executes with caller privileges and existing RLS, authenticates the active
owner, locks the session, validates stable IDs and the length/selection limits, and saves
the session fields plus context selection delta in one transaction. Existing matching
context rows are retained. No-op saves return false without updating `updated_at`.
Generated-question sessions are read-only. No policies, Storage structure, status,
question counts, candidate/reserve structure, or AI connections are changed.

Only a changed successful save invokes the existing recent-activity recorder; the existing
five-minute throttle is unchanged. Activity recording failures warn without undoing input.
The earlier Phase 2 "local-only/unapplied" notes above are historical: Storage reservations
and recent activity were applied and verified in the approved project before Phase 3-A.
The context-save RPC is now installed; there is no pending migration for this feature.

Real TEST Participant checks verified save/reload and fresh authenticated reads, partial
drafts, stable IDs, reflection-selection limits, Unicode 1,000/1,001 boundaries, no-op
timestamps, foreign/inactive denial and generated-question freeze. The freeze fixture was
created inside a transaction and rolled back. A context-row lock forced a real RPC
statement timeout after its session update; both session and selection changes rolled back.
No production trigger, policy or permission was modified to induce the failure.
Browser checks exercised the real save action, automatic field clearing, rapid text edits,
and text deletion. Existing rows, policies, columns, functions and Storage objects were
checked against preflight fingerprints. No model or prompt is imported by this feature.

Activity verification used real elapsed time: a successful browser context save advanced
the recent-use timestamp after more than five minutes; subsequent successful saves and
six concurrent recorder calls within the window did not advance it. No timestamps were
backdated for testing. TEST accounts `P990000004`/`P990000005` were deactivated, passwords
rotated and temporary credentials discarded after verification. Two new TEST drafts and
one registered TEST PNG (with its Storage object/reservation) are retained under the
existing research-retention policy; the temporary question fixture was rolled back.
Final totals: six profiles, nine sessions, two context rows, 34 registered images,
34 Storage objects, 34 reservation slots and zero questions. No orphan/missing objects
were found. All pre-existing research/profile rows and Storage objects remained unchanged.

Run `npm run test:context` for input validation, debounce/serialization/retry behavior,
mocked save-action authorization/activity, rendered controls, and migration contract
checks. Keep the existing Storage and activity suites in the regression run.

### Three-step session wizard

Participant login and Home open the latest owned unfinished session at its last
visited wizard step saved in this browser (step 1 if there is no saved position).
If none exists, the existing auto-start form creates a draft and redirects to step 1;
Server rendering/prefetch does not insert a session.
Home/header-brand links use document navigation so the latest-session lookup and
saved wizard step restoration also occur when leaving an already-mounted session.
The Record page now contains the former home greeting, usage counts and all owned
sessions ordered by latest work time.
Creation-order numbers identify each entry independently of that display order.
Unfinished entries (including `summary_ready`) are orange with `이어하기`; only
`completed` entries are black with `상세보기`. The existing completion guard requires
a saved final summary. Completed details show that summary read-only.
The Record `새 성찰 시작` button submits the existing authenticated creation action
directly and redirects to wizard step 1, without a preparation/confirmation screen.
Direct visits to `/sessions/new` submit that same action once per mounted form (including
Strict Mode effect replay); failures retain the explicit error and manual retry button.

The same session URL now presents three steps: (1) design upload, (2) design
category/subcategory, work stage and reflection contexts, and (3) optional work context.
Next validates only the current step: at least one registered image; valid category,
matching subcategory, stage and nonblank other-category text when applicable; then
one to three distinct reflection contexts together in step 2. Previous does not validate or save.
The final question-generation CTA now uses saved-input eligibility (Phase 3-C-3 below).
The headings are `1단계 - 이미지 입력`, `2단계 - 정보 입력`,
and `3단계 - 작업 맥락`.
The final-step helper uses `public/images/ai.png` in light mode and
`public/images/ai-dark.png` with white guidance in dark mode. The reflection selection
panel uses a dark surface, light text and subdued hover/checkbox colors in dark mode.
Selected dark-mode checkboxes use white fill with a dark check; unselected rows are
subdued, with further dimming when disabled by the three-selection limit.
The selected category trigger uses the same dark orange token as in-progress record
cards, retaining that fill on hover.
Future static UI
images can be placed in `public/images/`. Its textarea retains an accessible name
without a visible optional-field label.
`public/images/icon.png` is the shared favicon and the 32 px icon preceding the
Participant/Admin header description.
Only the smoothly filling progress gauge remains below the heading, without
duplicate step labels; reduced-motion preferences disable the transition.
Previous/Next controls are fixed at the viewport bottom, with reserved content
space and safe-area padding. Toasts and the theme control sit above the footer.
Step 1 offers an Exit (`나가기`) link to Record in place of Previous, preserving the editor's existing
unsaved-navigation confirmation. The Record page uses the same fixed footer with
the existing new-session form aligned on the right.
Design selection is one grouped dropdown: primary categories are nonselectable
group headings, and selecting a subcategory derives its stable primary ID.
The custom rounded listbox supports arrow/Home/End keys, Escape, outside-click
dismissal and focus restoration; selected rows are highlighted.
Selecting a regular category clears the other-category text. All five work stages
are visible as single-choice native radio tags with keyboard navigation. Step 2
keeps work-info fieldset labels but removes their enclosing boxes. Its reflection panel uses larger rounded
black checkboxes with white check marks.
Work-info labels have extra spacing above their controls. The classification trigger
centers its label and arrow vertically, with light-orange hover/focus/selection feedback.
The selected classification trigger has a light-orange fill, orange border and black
text; trigger hover preserves its fill and lightly reduces opacity. The reflection
label sits outside the white checkbox panel. The home in-progress notice uses a
semibold message ending in `···`.
Toasts and theme controls sit 76 px above the bottom on fixed-footer pages (plus
safe-area inset), retaining clearance above the 61 px footer. Upload preparation
uses a toast rather than inline status text. Upload content is shifted down slightly.

Participant and Admin sticky headers hide on downward scrolling and reappear on
upward scrolling or near the top; focused/open navigation stays visible.
They show navigation and logout in a hamburger
at viewport widths of 1024px or less, and inline navigation above that breakpoint.
The home start button is right aligned. Shared notices are boxed, centered bottom
toasts without close icons, borders or shadows, with slide-up entry and slide-down exit.
The upload action uses larger text, while format/size and paste-key hints use
smaller supporting text; the per-file 10 MB validation remains unchanged.
The format/size hint sits directly below the upload action text. The home greeting
uses the authenticated profile's participant code, and the in-progress notice
uses the theme-aware light orange surface. Login uses the same tool description
as the header.
Toast backgrounds use black at 80% alpha with white text in light mode, and
white at 80% alpha with black text in Participant dark mode; text stays opaque.
Informational results expire after six seconds and errors after eight seconds;
confirmations remain until explicitly resolved. AI replacement and
unsaved-link navigation confirmations use explicit cancel/confirm toast actions.
Browser tab-close/reload protection still uses native `beforeunload` warnings.
Autosave/loading statuses and explanatory helper text stay inline.
The upload area uses a centered upload icon/file-picker button, a subdued image
count and smaller format/size/paste hints. Native file-input chrome is hidden;
drag/drop, paste, multi-file selection and existing upload limits are unchanged.
Paste shortcuts use keycap badges. Previews use five columns on desktop and two
columns at tablet/mobile widths (1024 px or less), with square image areas;
long filenames are truncated visually. The final context textarea starts at
12 rem (1.5 times the previous height), and its helper text is shifted down 2 px.
The image refresh button is temporarily disabled and hidden (its handler is retained);
the image count appears in its former action-row position below the upload area.
Automatic refresh after upload
and upload retry remain available. Design classification group headings have
subtle backgrounds, and stage tags/check rows include hover feedback.

### Image deletion (Production migration verified; feature flag remains separate)

The circular thumbnail X asks for confirmation, then sends an authenticated,
same-origin `DELETE /api/session-images?session_id=…&image_id=…`.
The server derives the private path from `begin_image_deletion`; paths are never
accepted from the browser or included in responses/logs.

[20261006031000_image_deletion.sql](./supabase/migrations/20261006031000_image_deletion.sql)
introduces a small operational `image_deletions` table, including completed
tombstones to prevent old upload request IDs from resurrecting deleted images.
The flow is a retryable two-phase operation, NOT an atomic transaction across
PostgreSQL and object storage:

1. Lock/check active owning Participant, editable session and absence of questions;
   persist a pending deletion claim and release the transaction.
2. Remove the object through the authenticated Supabase Storage API.
3. `finish_image_deletion` independently verifies that `storage.objects` no longer
   contains the path, then atomically deletes image metadata, releases the matching
   reservation, and completes the claim. Only a changed completion records activity,
   through the existing five-minute throttle.

Storage failures retain metadata and capacity. If Storage succeeds but finalization
fails, the pending claim survives: the list displays a deletion-pending placeholder
and offers deletion retry even after reload. No optimistic removal or capacity
release occurs. Completed retries are no-ops. Other images retain their IDs and
sort_order values (gaps are intentional); replacements append after the highest
remaining reservation/image sort_order. Five-column previews remain ordered.

The migration narrowly replaces reservation guard/path-check functions and the
restrictive Storage UPDATE policy, adds a restrictive claimed-delete policy and
image/question/session-state guards. Active deletion blocks object re-creation,
metadata rewrites, new reservations and advancement/question insertion until resolved.
Existing research preservation guards, ownership policies and context-save/claim
RPCs remain in place. Tombstones are operational state, not AI draft history.

`SESSION_IMAGE_DELETION_ENABLED` defaults to false. This migration was verified on the
separate hosted TEST project and then applied to approved Production on 2026-10-08,
before the question-generation foundation. Deployment does not enable the deletion flag;
X controls/DELETE remain gated until separately enabled. Existing Context Draft settings
are independent and must not be changed as part of this rollout.
Resolve all pending deletion claims before disabling the feature again; otherwise
the recovery UI is hidden while database guards correctly continue to block advancement.

Run `npm run test:image-delete`. PGlite tests execute all existing migrations plus
the new migration in isolated PostgreSQL, with synthetic Auth/Storage tables, and
exercise RLS, rollback, slot reuse, tombstone replay protection and question freezing.
Provider/API/UI tests use mocks. This does NOT verify hosted Storage byte deletion
or true parallel transactions on separate PostgreSQL connections.

Before remote rollout, compare schema/policy/data fingerprints, verify real Storage
removal and failure recovery/reload, two concurrent deletes, delete/upload and
delete/question races, foreign/inactive/frozen denial, 10→9→10 capacity, retained
order, old request replay denial, context autosave/claim/activity regressions and
TEST-only cleanup. Do not release pending slots by bypassing guards.

The bottom fixed bar shows context autosave status on the left and navigation on
the right. On load the timestamp uses persisted session `updated_at`; after a
changed autosave it shows the browser's successful-save acknowledgement time.
Times are displayed in Korean/Asia-Seoul with seconds; no-op saves do not advance
the timestamp, and failed saves do not claim success. It is a save indicator, not
a separately persisted action log. The redundant maximum-three helper text is
removed; the counter and client/server three-choice limits are unchanged.

Uploader and input components remain mounted in hidden panels during navigation.
Image refresh/retry, pending uploads, inputs, autosave timers and save-status/retry controls
are retained; moving between steps neither calls nor waits for a save.
Reload/reentry, including Record resume links, restores the last visited step from a
session-specific localStorage key. New sessions start at step 1; older sessions without
a browser entry also start at step 1. This UI preference is browser-local and does not
sync across devices. Storage read/write failures show an explicit toast without blocking
input/autosave; invalid saved positions report an error and open step 1.
Persisted inputs/images still use the existing server queries and image endpoint. These navigation
requirements do not tighten the existing partial-draft save validation.
No migration, RPC, RLS, Storage, prompt or autosave implementation changes are required.

## Phase 3-C-1 question generation DB foundation

[20261008031500_question_generation_foundation.sql](./supabase/migrations/20261008031500_question_generation_foundation.sql)
was applied and verified on Production on 2026-10-08, after image deletion.
Both post-migration catalogs matched the tested contracts and all seven existing
research/Storage metadata count/hash aggregates and bucket configuration remained
unchanged. This database phase did not enable the CTA or call OpenAI.
The frozen question prompt v2.5, strict schema v2.0 and Context Draft prompt remain unchanged.

The read-only remote comparison matched the six deployed baseline migrations by
catalog content: 24 public function bodies/security settings/signatures/ACLs,
19 related triggers, 24 public policies, question/session constraints, indexes,
columns and role/column grants. Supabase's observed default function privileges
must be reproduced when comparing ACLs; bare PostgreSQL defaults differ.
Remote PostgreSQL 17 stores NOT NULL in `pg_attribute`; local PostgreSQL 18
also emits NOT NULL entries in `pg_constraint`. Attribute-level nullability matches.
The remote migration-history table was absent, so recorded migration versions
are not verified. Do not replay applied SQL files or assume SQL Editor deployment
also registered CLI migration history.

### Attempt, candidate and commit contract

- `question_generation_attempts`: `running`, `completed`, `failed`, unique
  `(session_id, request_id)`, and one running attempt per session. The snapshot
  records saved categories/stage/context IDs/additional context, existing N and
  image IDs/order/private object paths/metadata, never signed URLs or API keys.
- `begin_question_generation(session_id, request_id)` is authenticated Participant-only.
  It locks the parent session, verifies active ownership, complete saved inputs,
  1-10 registered/private objects and no existing questions or unresolved uploads/deletions.
  Only the winning response has `acquired: true`. Same-ID replay, an existing
  running attempt, or a completed attempt returns its identity/status without acquiring.
  Failed-ID replay does not retry; an explicit new request ID is required.
- Active attempts freeze category, stage, reflection contexts, additional context,
  requested count, image metadata/add/delete/order, reservations and Storage writes.
  Parent-row-locking triggers cover trusted/direct database writes in addition to RLS.
  A restrictive session UPDATE policy also denies unchanged autosave and automatic/manual
  Context Draft claim RPCs at their `FOR UPDATE` lookup. Input edits resume after failure;
  existing question-history locks remain after successful materialization.
- `stage_question_generation_candidates` is service-role-only. The server
  must first perform frozen-schema and semantic validation. The RPC independently
  revalidates five ordered unique ranks, framework hierarchy, nonempty/distinct text,
  selected context references, top-N context coverage, 0-3 text guides, real unique
  image indices and target cardinality/positive bounded regions. Additional keys
  are rejected. Validated payloads are capped at 256 KiB as an operational safeguard.
  These checks do not prove semantic diversity or design quality.
- `related_contexts` preserves the exact output strings; `context_ids` separately
  normalizes exact stable IDs or current exact labels to distinct selected IDs.
  No fuzzy label matching, label rewrites or new research taxonomy is introduced.
  `answer_guides` is an ordered text array; `target` preserves the strict frozen
  `{type,image_indices,region}` object. Version metadata uses
  `question-generation-v2.5`, schema name `why_box_question_generation_v2_0`,
  and framework `v1.0`.
- Staging persists only validated candidates and safe metadata, not the raw OpenAI
  request/response, credentials, signed URLs or reasoning. Restaging identical
  output is a no-op; changing staged output is rejected.
- `commit_question_generation(attempt_id, request_id)` is service-role-only and
  rechecks the current snapshot/active participant. ONE transaction saves all five
  immutable `question_candidates`, creates exactly rank 1..N original questions
  and real image targets, sets session `draft -> question_generation -> in_progress`
  and attempt `completed`. Existing deferred target/lineage/active-version guards
  remain. Any insert or state-transition failure rolls back all materialized rows
  and session/attempt transitions; the separately staged valid output survives.
- `questions.source_candidate_id` is a same-session FK and immutable original
  provenance. Reserves never become inactive originals or answer/skip slots.
  `selection_reason` keeps its original NOT NULL constraint and stores only
  `system:initial_top_n;candidate_rank=R;requested_question_count=N`.
  This is deterministic display selection provenance, **not** a model-generated
  explanation, research evidence of ranking quality, or chain-of-thought.
- Candidate/attempt tables have owner-or-active-admin SELECT policies. Browser
  and service clients cannot directly mutate them; privileged RPCs perform writes.
  Helpers/trigger functions are not publicly executable. Completed retries return
  `saved: false`; results are available through existing owned question SELECTs
  joined to candidate provenance, without another generation.

### Failure and reconciliation

The server must distinguish API/validation failures from recoverable
post-API commit failures. While a staged running attempt remains eligible, explicitly
retry **commit**, never OpenAI, after resolving a transient DB failure or lost response.
After uncertain commit, first read attempt status: completed means use saved results.
`fail_question_generation` accepts only service role and fixed safe codes
(`QGEN-API`, `QGEN-TIMEOUT`, `QGEN-VALIDATION`, `QGEN-COMMIT`, `QGEN-STALE`,
`QGEN-CANCELLED`); completed/failed calls are no-ops. No raw error text is persisted.
Failed attempts retain staged audit data but cannot commit. A participant's next
explicit request gets a new attempt and a fresh snapshot. No automatic external
retry, scheduler or stale timeout is added; trusted stale reconciliation must
establish that the previous runner is no longer eligible before failing it.
Never mark a still-recoverable staged commit failed merely because its first response was lost.

The migration works with the deployed baseline alone, or with the earlier local
image-deletion migration already installed. Its conditional deletion guard does
not deploy or enable deletion. Do not install that older optional migration
**after** this migration without separately adding/verifying its generation lock:
that out-of-order path is not covered. Unresolved upload reservations intentionally
block begin; finish/retry the existing upload path rather than deleting reservations
or bypassing history guards.

Run `npm run test:question-db`. Tests use mock candidates and isolated PGlite Auth/Storage
catalog fixtures, including observed Supabase default function grants. They cover
N=1/3/5, target mapping, provenance, privilege/RLS denial, invalid candidates,
active locks/failure unlock, injected candidate/question/target/state failure and
recovery without another generation. Concurrent promises verify a single acquired
claim, but PGlite serializes one connection and is not independent-connection evidence.
Hosted TEST validation subsequently verified real authenticated upload/download,
10 -> 9 -> 10 capacity, two-phase deletion/recovery and active generation locks.
One immediate default SDK download after deletion succeeded transiently; later
default download and fresh authenticated requests failed, with object metadata absent.
Universal immediate cached-URL revocation and the cause of that observation are
not verified. No existing Production object was deleted for validation.

## Phase 3-C-2 server question pipeline (no UI or live validation)

`POST /api/question-generation` accepts only `{session_id, request_id}` UUIDs.
The same-origin route verifies Auth and an active Participant, then uses the caller's
`begin_question_generation` RPC as the authoritative ownership/input/state gate.
Server-only `OPENAI_QUESTION_GENERATION_MODEL=gpt-6-astra` is independent of
`OPENAI_CONTEXT_DRAFT_MODEL`; there is no fallback. SDK version remains pinned.
Setting the model does not authorize live validation.

The pipeline reads the attempt's persisted snapshot through caller RLS, maps stable
IDs using research constants, checks every private object through authenticated Storage
listing, and signs all images in snapshot order for 180 seconds. Service role is used
only for stage/commit/safe failure RPCs, never Storage or direct table writes.
Only `acquired: true` can invoke OpenAI Responses; `store: false`, `maxRetries: 0`,
SDK logging off, and the active prompt/unchanged strict JSON Schema are used.
The returned model ID and provider creation time are persisted as generation metadata.

### Active AI prompt revisions (2026-10-13, local only)

- [Question generation v2.5](./src/lib/ai/prompts/question-generation-v2.5.ts)
  retains its DB-compatible version with the approved 2026-10-13 wording revision,
  adding context-relevant design terminology
  rules and terminology self-checks. English is optional for clarification on
  the first occurrence across the five candidates, not repeated per question.
  Framework, question types, ranking, five-candidate count, answer guides,
  targets, JSON schema and validation are unchanged. The DB constraints and RPC
  allow only v2.5, so generation metadata still records v2.5; the code revision
  distinguishes this wording update. Tests strip only the added rules and
  self-checks, then verify the original prompt's SHA-256. Existing attempts and
  stored questions are not rewritten.
- [Context draft v1.2](./src/lib/ai/prompts/context-draft-v1.2.ts) builds on v1.1,
  replacing the rule that implied a selected review target was already being
  reviewed. New drafts describe supported purpose/state/review targets, omit
  unnecessary first-person openings and wish-based phrasing, and do not infer
  ongoing/completed review or a committed plan from selected interests.
  User-edited text and stored context remain untouched.
- [Design briefing v1.4](./src/lib/ai/prompts/session-design-briefing-v1.4.ts)
  builds on v1.3, adding client-facing professional style and faithful
  reformulation of wishes. Work state must be explicitly supported by confirmed
  context or a final selected answer. New briefing provenance records v1.4;
  the v1.0 response schema and existing saved briefings remain unchanged.
- The request builders and mocked SDK tests verify the active revisions.
  Only active prompt versions are retained in the prompt directory; context and
  briefing prompts are standalone files with no dependency on older versions.
  Their resolved text is unchanged by this cleanup and verified by SHA-256 tests.
  The separate one-question
  regeneration and sentence-refinement prompts are unchanged. No live model
  calls, remote data changes, migrations, push or deployment are required.

Validation rejects incomplete/refused/non-JSON output, anything except five candidates
in rank 1..5 order, invalid framework hierarchy, duplicate/empty questions, invalid
guides, unavailable/duplicate image indices and invalid region/cardinality. Related
contexts must be exact selected stable IDs or labels; aliases referring to the same ID
are rejected rather than deduplicated. Their exact AI strings are preserved and the DB
independently stores normalized IDs. At least one top-N candidate must reference a
selected context, matching the deployed RPC. The server also applies a conservative
240 KiB JSON transport bound below the DB's 256 KiB jsonb-text bound.

Stage retains all five validated candidates. Atomic DB commit materializes only ranks
1..N using saved `requested_question_count`, creates targets/provenance, and moves the
session to `in_progress`. Response contains only request/attempt IDs and question IDs,
not reserve candidates, images, model/config, prompt or generated payload.

Replay behavior:
- Running without staged output: HTTP 202, `retry_same_request: true`, no provider call.
- Staged running output: commit recovery using the attempt's original stored request ID,
  even if the browser retry supplied a different request ID; no provider call.
- Completed: re-read the five candidate provenance rows and N original question IDs;
  no provider call.
- Failed request: HTTP 409; only an explicit new request ID may start a new attempt.

The whole route has a 60-second deadline and request abort signal. An acquired,
unstaged attempt's ordinary provider/image/validation/config failures use the safe
failure RPC with a separate bounded 8-second cleanup window. Confirmed SQL stage
rejection can fail safely. Ambiguous stage responses are re-read before any cleanup:
staged/completed state is preserved; uncertain late/in-flight staging is never
arbitrarily marked failed. Commit failures always preserve staged output for retry.
Cleanup/readback failure returns `QGEN-RECOVERY` and logs only safe code/phase/request ID.
DB unavailability, ambiguous begin/stage execution or abrupt process death cannot
guarantee automatic lock release; these require trusted stale reconciliation after
confirming the previous runner cannot still execute. No scheduler/guard bypass or
unapproved DB change is introduced. Hosting must support the route's 80-second maximum.

This server implementation phase did not connect the Step 3 CTA or add remote fixtures,
remote writes or real OpenAI calls. Later live validation and UI integration are separate phases.

Run `npm run test:question-server` for deterministic SDK/route/lifecycle mocks and
real isolated PGlite RPC-backed server pipeline tests. Run it together with the
existing question DB, Context Draft, context, image deletion, upload and activity
regressions. The independent native PostgreSQL suite remains opt-in below.

### Phase 3-C-1.5 native PostgreSQL verification

The native concurrency suite is
[question-generation-concurrency.test.mjs](./tests/question-generation-concurrency.test.mjs).
It requires an explicitly enabled, fresh disposable local cluster, not an application
database. It never loads project environment files or accepts a remote host/URL.
Default target: loopback `127.0.0.1:55439`, PostgreSQL user `postgres`;
override only the local port and `psql` executable with `PG_TEST_PORT`/`PG_TEST_PSQL`.
Run `npm run test:question-concurrency` after starting that dedicated cluster.
Without `PG_TEST_ENABLED=1`, the native suite is skipped during generic test discovery.
It refuses a cluster already containing the Supabase fixture roles, creates its own
temporary database, and drops that database and fixture roles after the run.

Verified on native PostgreSQL **17.5** (remote is 17.11), using separate `psql`
processes/TCP connections, not PGlite. `pg_stat_activity` exposes distinct backend
PIDs/transactions and `pg_blocking_pids` records actual overlapping lock waits.
All six scenarios plus the suite passed (7/7):

- Fresh deployed baseline -> image deletion -> question generation foundation applies.
  Baseline function definitions/ACLs, public trigger definitions, policies and
  constraints have matching aggregate fingerprints with the read-only production catalog.
- Same and different request-ID races each acquire exactly one execution right
  and retain one running attempt, with no materialized questions/candidates.
- An uncommitted begin races additional context, context selection, requested count,
  reservation, direct image registration, image deletion and reorder on independent
  backends. Each waits and then fails at the generation-lock guard after begin commits.
  Local Storage metadata writes/deletes and autosave/deletion RPCs also fail while active.
- Explicit failure restores participant save/count/reorder/upload/deletion and
  automatic/manual Context Draft claim behavior. This validates migration replacement
  compatibility, not remote Storage bytes.
- Concurrent commits for N=1/3/5 produce five candidates, exactly N questions,
  respectively 1/4/6 unique targets, `in_progress` session and completed attempt.
  Only one reports a new save; retry and result SELECT recover without another generation.

No migration/RPC changes were needed for these native tests. The approved order
remains deletion **before** foundation. Reversing it can install deletion tables
without the conditional generation-lock trigger and replace the reserved-path
function/policy contract after foundation installation; this order is unsupported.

The verification used synthetic Auth/Storage SQL catalogs, not the actual Supabase
Storage service/object-byte backend. Thus hosted upload/delete recovery, provider
transaction behavior and real byte deletion remain a rollout blocker for the
image-deletion migration. Both migrations remain local-only, with no OpenAI calls.
Do not apply either migration to research data without explicit approval and
hosted TEST-only Storage validation.

## Phase 3-B context draft (claim migration deployed, AI not activated)

`POST /api/context-draft` authenticates an active owning Participant, validates the
current UI snapshot against the existing stable IDs, checks editable session state and
absence of questions, and queries registered images in `sort_order`. It uses the caller's
RLS-protected client to claim the automatic opportunity and sign every private image
for 180 seconds. One failed image preparation fails the whole request. No client URL,
Storage path, label, model or prompt is accepted.

The server-only OpenAI SDK is pinned to `7.28.0`. Its non-streaming Responses request
passes the active `context-draft-v1.2` as instructions, selected labels
and the ordered images, with `store: false`, SDK logging disabled and zero SDK retries.
The complete route has a 60-second deadline. Refusals, interruptions, empty output,
Unicode output longer than 1,000 characters, rate limits and API/configuration errors
have separate safe codes. No key, signed URL, participant context or generated text is
logged. `store: false` is not a guarantee of provider zero-retention.

The following settings are server-only and lazy; missing AI settings do not break
existing pages, images or autosave:

```dotenv
OPENAI_CONTEXT_DRAFT_ENABLED=false
OPENAI_API_KEY=
OPENAI_CONTEXT_DRAFT_MODEL=
```

Keep the enable flag false until separately approved live activation. No model ID is
guessed from the ChatGPT "Astra" name. When disabled/unconfigured, the route fails with
`DRAFT-CONFIG` before claiming or signing images. The new schema is not selected by
existing page queries, so an unapplied migration does not prevent Phase 2/3-A use.

[20261005231000_context_draft_claim.sql](./supabase/migrations/20261005231000_context_draft_claim.sql)
was applied to the approved remote project through SQL Editor in Phase 3-B-1.
Do not replay it or earlier migrations; CLI migration history is still unreconciled.
It adds only nullable
`sessions.context_draft_auto_claimed_at`, an immutable-marker trigger and a caller-
privileged `claim_context_draft` RPC. The RPC locks the owned session, verifies active
Participant/editability/no questions/registered images and the validated UI snapshot,
then atomically consumes the opportunity before any external call. The transaction
ends before signing images or invoking OpenAI. A losing automatic request returns
false; manual generation remains allowed with the same marker. Existing saved text
causes automatic requests to consume-and-skip, never overwrite. Once set, the marker
cannot be reset or changed, including by direct table UPDATE. Direct owner updates
can consume, but never restore, the opportunity. No RLS policy, Storage policy, existing
save RPC, prompt, research-text column or research row is rewritten. The technical
claim can advance `sessions.updated_at` through the existing trigger; it does not record
Participant activity. Only existing successful changed autosaves record activity.

The final step's mounted controller attempts automatic generation once per mount after required
inputs/images are ready; existing textarea content skips the local automatic attempt.
The persisted RPC prevents another external auto call after reconnect or text deletion.
Failures after a successful claim never reset it; retry is manual. Strict Mode cleanup
is deferred for one microtask so its immediate re-attach does not cancel and duplicate
the initial request. Real unmounts abort/invalidate pending work. Per-request identity,
textarea edit revision, upstream input revision/fingerprint, image identity/order and
current editability protect application of results. Superseded results cannot update
the newer request's state. These guards cover this mounted editor; cross-tab concurrent
manual editing remains subject to the existing autosave behavior.

`AI로 다시 작성 ↻` is currently hidden in the final step; its handler and replacement
confirmation remain in place. The footer and below-textarea explanatory copy are
removed, and a subdued character counter sits inside the textarea's bottom-left
corner with reserved padding so it does not overlap entered text. Existing text remains while
loading or on failure. An accepted result patches only the latest `additional_context`
through the existing form change function and 1-second `ContextAutosave`; there is no
direct AI-to-DB write. Save failures keep the displayed draft and existing save retry.
Question generation's final CTA is connected in Phase 3-C-3 below; its server-only pipeline
is described above. No raw Context Draft/history is stored.

Run `npm run test:context-draft` for mocked provider/API/claim/controller/form tests.
The complete mock and regression command is:

```sh
node --experimental-strip-types --test tests/context-draft.test.mjs tests/session-context.test.mjs tests/auth-session.test.mjs tests/storage-upload-slots.test.mjs tests/storage-upload-api.test.mjs tests/participant-activity.test.mjs
```

Phase 3-B initially used mocks only. Phase 3-B-1 applied the exact migration
(SHA-256 `bafc5cdd91333ff666355e4ba9d8de1cc58cbdcc09976781931cbe487a20a918`)
and verified actual caller-authenticated PostgreSQL RPC behavior. Two independently
authenticated requests started 0.1 ms apart, overlapped, and returned `[false, true]`.
Repeated auto claims did not change the marker or `updated_at`; fresh login preserved
the claim. Foreign/inactive requests, invalid snapshots and marker reset/change were
denied. Manual requests remained valid. Existing participant text consumed-and-skipped
the auto opportunity without overwriting it. The existing save RPC still saved inputs,
returned false on no-op without a timestamp update, and retained the marker after text
deletion. No OpenAI call or generated draft was used for any of these checks.

Question-present denial was tested using an authenticated role inside a transaction
with a TEST-only question; everything was rolled back. Another rollback-only transaction
tested manual claim with no prior marker, ten-image claim success, nonnull marker insert
denial and rejection of the eleventh image by the existing metadata guard. No trigger
or policy was bypassed to manufacture an over-ten state: the claim function's over-ten
branch was inspected but cannot be reached with valid existing guards. Temporary image
metadata was never committed and no extra Storage objects were created for that fixture.

All pre-existing research/profile rows, Storage objects/slots, columns (excluding the
new marker), existing functions/ACLs, triggers, constraints, table grants, RLS flags,
policies and bucket configuration matched preflight fingerprints both immediately
after migration and after tests. The installed RPC is invoker-only with an empty search
path, authenticated EXECUTE and no anon/service-role EXECUTE.
TEST accounts `P990000006`/`P990000007` were deactivated, passwords rotated and helper
Auth sessions signed out. Under the unchanged retention guards, three new TEST drafts,
four context-selection rows and two 1px TEST PNGs with objects/reservations remain.
Final totals: nine profiles, fourteen sessions, six context rows, 36 images/objects/slots,
zero questions and zero orphan/missing objects. The eleven pre-existing sessions still
have NULL markers; only two new TEST sessions retain claims. All 64 local regression
tests, lint and typecheck passed. The local enable flag is explicitly false; no API key
or model ID was configured and no OpenAI request was made.

Before live calls, confirm the exact available API model ID, credentials, provider data
handling/approved non-sensitive images, 10-image request limits, hosting timeout and
deployment-wide request/cost limits. Do not replay the previously applied migrations.

## Participant display preferences

Participant home uses `Home` and the tool description as its heading; the history
menu/title uses `나의기록` with the `Record` eyebrow. Every authenticated Participant
page includes a fixed circular light/dark toggle at the lower right, including mobile
safe-area spacing. A one-year SameSite cookie stores the preference and the server
layout restores it without a light-theme hydration flash. Default is light; theme
tokens are scoped to the Participant shell, leaving Admin/login unchanged. Cookie
storage failure is shown explicitly while the selected theme remains usable.
The Step 1 image dropzone uses dark surface/text tokens in dark mode, including
the paste shortcut keys; its orange drag highlight and light-mode appearance are preserved.
Step 3 uses a single live status beside the AI icon for default guidance, draft
generation progress and completion. Draft errors and stale/edit protection remain toast notifications.

## Phase 3-C-3 question generation UI

Step 3 offers keyboard-accessible question counts 1..5 seeded from the saved
`sessions.requested_question_count` (new-session default 3). Count changes use the same
serialized/debounced autosave implementation as context edits, through an authenticated
caller/RLS server action; no schema or generation algorithm change is needed.
Pending/failed context or count saves, Context Draft loading, pending image operations,
unregistered/failed image uploads, missing required inputs and generation locks disable
the CTA. Unsaved count changes retain retry and navigation/unload warnings.

Only an explicit click sends `POST /api/question-generation`, with session/request IDs
and no input overrides. A synchronous controller latch prevents duplicate clicks and
Strict Mode/rerender submissions. The request ID remains stable for that action.
Loading locks the session controls and shows explanatory status text, without a time
estimate or fake percentage. Context autosave stays mounted across generation locks,
so confirmed failure does not reset its saved snapshot or lose current edits.

Authenticated `GET /api/question-generation?session_id=...` is caller-RLS/read-only:
it checks an active participant and session ownership, reads attempt status (never
candidate payload) and returns only session ID, UI state, saved count, latest failed
request ID and ordered original-question ID/slot/text. It never invokes generation,
commit/failure RPCs, Storage writes or OpenAI. Responses are `no-store`.
The browser POST has a 90-second network deadline (not a displayed estimate or retry).
HTTP 202 keeps loading; subsequent checks use only GET, every five seconds, with at
most 12 automatic reads and a ten-second per-read deadline. Exhaustion/read errors
switch to locked recovery with a manual status-check button; polling is not indefinite.
An ambiguous POST cannot unlock based on an empty read: its own failed request must
be confirmed, or an explicit pre-begin rejection received. Staged recovery remains
locked and requires the existing trusted recovery/operator contract, not a new generation.
Reloading a running attempt starts bounded reads only, never a POST.

On success, the UI re-reads authoritative original questions, checks contiguous slots
and displays 1..5 question texts ordered by `slot_index`. In-progress session re-entry
shows those saved questions without generation. Completed sessions retain the existing
read-only summary screen. Internal reserve candidates, target/framework/model metadata
and selection reasons are not rendered. Answer/skip/regenerate/pin/completion UI is not
part of this phase.

`npm run test:question-ui` runs network-intercepted React DOM/jsdom component interactions
and controller/read-contract checks; unexpected network requests fail. These tests do
not use any hosted credentials or live OpenAI requests. Live deployed browser testing,
including hosting support for the existing 80-second route maximum, needs separate approval.

## Answer and image result interactions

The result editor has no visible answer label; its textarea retains the
accessible name "나의 생각". Its placeholder is "질문을 보고 떠오른 답변을 자유롭게 적어보세요."
The content padding reserves space for the textarea's outside focus ring.
Answer autosave uses attach/detach lifecycle handling so React Strict Mode effect
replay does not permanently dispose the controller. Question and image navigation
flush pending answers before moving; failed saves retain the text and require retry.
Arrow keys inside the answer editor move the caret, not the selected question.
Answer revision validation accepts both UTC `Z` and explicit timezone offsets
returned by Supabase/PostgreSQL. Revision strings retain their microsecond precision
without JavaScript date conversion for optimistic concurrency checks.
Safe answer error codes are translated through a shared message contract; server
details are not rendered. Failed prerequisite saves do not invoke refinement.
Refinement configuration errors are distinguished from answer-save failures;
refinement remains disabled unless separately configured and approved.

### Phase 3-D-3: sentence refinement integration and mock validation

The existing server-only Responses API provider uses the versioned
`sentence-refinement-v1.1` prompt; obsolete prompt files have been removed.
The prompt edits expression (spelling, grammar, repetition and flow) and may
naturally professionalize colloquial or overly hesitant wording for describing
design work. It preserves meaning, uncertainty, emotion, first-person viewpoint
and key content, and forbids turning uncertainty into a firm decision or adding
unmentioned intent, review, rationale, facts, advice, evaluation or explanation.
Already professional writing and short answers should remain concise and need
not be changed unnecessarily.
Only the server-read currently selected answer text is sent; no question,
image, profile or session context is sent. Model/key/prompt are never returned.

`OPENAI_SENTENCE_REFINEMENT_ENABLED` must equal `true`, and both
`OPENAI_API_KEY` and `OPENAI_SENTENCE_REFINEMENT_MODEL` must be present.
Phase 3-D-3 discovery found the refinement enable/model variables unset, causing
`REFINE-CONFIG` before SDK use. In the separately authorized Phase 3-D-3.1,
local settings were changed to enabled with model `gpt-6-astra`; other AI settings
were not changed. `.env.local` remains ignored. Browser E2E and use of participant
answers still require separate approval; enabling configuration does not expand
the authorized one-call validation scope.

The provider uses `store:false`, non-streaming text output, `maxRetries:0`,
a 60-second deadline and a bounded output token budget. Input and output are
limited to 20,000 UTF-16 code units, consistent with the answer editor/save
contract. Refusal, incomplete, empty, malformed, unexpected tool/multiple-message
output and common commentary/Markdown wrappers are rejected. Incomplete output
is never stored as a partial answer.

The route authenticates the active participant and editable question before AI,
then rechecks session/question state and source text/version/revision before a
revision-filtered update. Only refined fields and selected version are updated;
`original_answer` is never overwritten by refinement. Existing RLS, column grants,
triggers and constraints remain unchanged. No migration is needed or applied.

Concurrent identical user/question/revision requests share one operation within
one server process, including one provider call and one write. Another revision
for the same in-flight question returns `REFINE-BUSY`; completed/failed operations
are released. This is **not durable or cross-instance idempotency**: existing DB
contracts have no refinement claim/ledger. Multiple instances could call the
provider concurrently, although the DB compare-and-set allows only one result
to persist. Timeout or response loss is not automatically retried. A durable
claim/replay contract would require a separately approved DB design/migration.

The client flushes autosave, snapshots the source, blocks duplicate clicks and
question/image navigation, and gives the request a 65-second deadline. The action
label becomes "문장을 정리하고 있어요..." without changing the lightweight style.
A subtle pulse is confined to the action icon and disabled for reduced motion;
the answer field no longer flashes orange while refinement is pending.
A strict response schema plus local source/version/revision checks prevent late
results from replacing edits or another question's answer. Failures retain text;
original/refined switching and re-entry reuse the existing autosave/read contract.
The hidden answer/saved labels and recent result UI are preserved.

Mock tests cover editorial sample inputs, malformed/provider failures, timeout,
duplicate requests, stale revisions/text/versions, state/ownership gates, original
preservation, undo, saved re-entry and navigation locks. Mock outputs validate
plumbing and preservation, **not real-model semantic quality or accessibility**.
No hosted writes or live OpenAI calls are part of these tests.

#### Phase 3-D-3.1: single synthetic live validation

On 2026-10-09, model metadata retrieval returned HTTP 200 for `gpt-6-astra`.
Exactly one Responses request then used the existing `refineSentence` service
and prompt with the supplied synthetic answer, `store:false`, zero SDK retries
and the existing 60-second deadline. An external server-test harness counted the
HTTP request and blocked repeated execution; it did not import DB clients or
invoke the application routes. No participant answer or image was sent.

The response was HTTP 200 / completed, no refusal or incomplete output, and
passed the service output validator and the existing persistence result schema.
Duration was 4,077 ms; tokens were 463 input, 85 output, 548 total.
The text corrected spacing and sentence flow while retaining uncertainty,
both opposing considerations and first-person colloquial viewpoint. No new
facts, recommendations or design decisions appeared in this sample.
This is a one-sample quality PASS, not general semantic safety certification.

The result was not stored in Supabase. Original/refined storage, undo and re-entry
remain mock-verified only; live browser E2E was not performed. The complete local
regression remained 209 pass / 0 fail / 1 opt-in native concurrency skip (210 total).
Lint, typecheck and production build passed. No frozen prompt/schema or migration
was changed; no Question Generation, Context Draft or Regeneration call occurred.

#### Phase 3-D-3.2-A: isolated TEST runtime preparation

Run `npm run dev:test` to start a TEST-only Next.js instance at
`http://localhost:3001`. It reads the existing ignored `.env.storage-test.local`
and maps its TEST-specific URL/publishable/service variables into the application
environment. The launcher refuses any URL other than TEST
`njtgxnlxlhxpbiekbgmv`, checks JWT project/role claims when applicable, verifies
TEST Auth settings with a read-only request, and refuses an occupied port.
It removes inherited Supabase/public/Next/AI settings, clears the OpenAI key and
all model settings, and explicitly disables refinement and Context Draft.
Question Generation fails configuration checks without an API key/model.

Production `.env.local` and the existing port 3000 server are unchanged.
The TEST instance runs an ignored source snapshot under `.test-runtime/app-*`,
with its own Next cache/generated types and without copied env files.
Webpack is used for this snapshot so dependencies can be shared without sharing
the live application's compiled public configuration. Restart `dev:test` after
source changes; it creates a fresh snapshot. The root TypeScript/lint configuration
excludes generated snapshots. TEST uses `localhost` rather than Production's
current `127.0.0.1`, and Supabase additionally uses project-specific Auth cookie
names (`sb-njtgxnlxlhxpbiekbgmv-auth-token`).

Read-only verification routes are installed **only into the TEST snapshot**:
`/test-environment` instantiates the real browser Supabase client and reads the
local session, and `/api/test-environment` checks the running server's TEST project,
Storage hostname and disabled AI settings. Neither returns credentials or writes
research data. These routes are not in the Production application source tree.
A browser check confirmed the TEST SDK/project in its client bundle, no Production
project reference, no Production Auth cookie and no authenticated TEST session.
TEST REST and private `why-box-images` bucket access returned HTTP 200.

Read-only Production/TEST comparison on 2026-10-09 found matching answer RLS
policies and enabled protection triggers, but TEST is missing:

1. `20261008220000_answer_refinement_version.sql`: adds
   `current_answer_version` (default original), version constraint and refined-field
   column update grants. Existing TEST answers count is zero.
2. `20261009002000_question_actions.sql`: adds request ledger, immutable-history
   guard, capability/mutation RPCs and candidate uniqueness index, and extends
   provenance validation. Existing source-candidate duplicates count is zero.

Apply only after explicit TEST migration approval, in the order above.
Neither project has a `supabase_migrations.schema_migrations` ledger, so installed
objects, not recorded migration version numbers, were compared.
No migration was executed in this preparation step.

TEST has three confirmed password Auth users, each linked to a Participant profile;
all three profiles are deactivated. The existing synthetic in-progress session
`e04487c3-1ba7-41f2-8c18-c8e17a3f1c88` belongs to TEST code
`P99251791457073474`, with three active questions, three valid image targets,
one stored image, two unused reserves and no answers. Reactivating that existing
TEST owner requires separate approval. Password availability and actual login
remain unverified; password reset requires separate approval if needed.
No new account/session/question/answer is required based on the current catalog.

Browser result rendering, answer version persistence and E2E are blocked until
approved TEST migrations and account preparation are completed. No account/data
changes, Production writes, AI calls or browser refinement were made in this step.

#### Phase 3-D-3.2-B: approved TEST migrations applied

On 2026-10-09, only TEST `njtgxnlxlhxpbiekbgmv` received the approved existing
migrations, in this order:

1. `20261008220000_answer_refinement_version.sql`
2. `20261009002000_question_actions.sql`

Each exact file hash was checked before execution. Both transactions returned
success; the first migration's answer contract was compared to Production before
the second was applied. Final columns, constraints, RLS, policies, column/table
grants, triggers, indexes and function definitions/security/ACLs match Production.
All relevant indexes are valid/ready, constraints validated and guards enabled.
The new action request ledger has zero rows; direct insert/update/delete/truncate
is denied to anon, authenticated and service_role. Participant capability RPC is
authenticated-only; mutation RPC is service-role-only.

Before/after counts and full-row fingerprints remained identical for TEST
sessions (3), questions (3), candidates (5), targets (3), images (1), generation
attempts (2), answers (0), events (0), profiles (3), Auth users (3) and Storage
objects (1). Broken targets/provenance and duplicate source candidates remain
zero. Production's compared catalog and all eleven data fingerprints also remained
identical. No migration history ledger was created or populated; actual catalog
installation was verified.

All fourteen protected files (three frozen Question/Context files, refinement
prompt and ten existing migrations) and both environment files remained unchanged.
No Auth activation, answer creation, question action, browser E2E or OpenAI call
was performed. TEST DB preparation is complete; account preparation remains
blocked pending separate approval, with zero active TEST Participants.

#### Phase 3-D-3.2-C: approved TEST Participant login preparation

On 2026-10-09, the existing synthetic session owner
`3bef894c-dd82-40b4-92a3-6387060c6ce0` was confirmed to have a verified password
Auth account, Participant role and correct ownership of the existing three-question
session. Its profile was deactivated and Auth login banned. Separate explicit
approvals were received for reactivating this one TEST account and resetting its
unavailable password. Only its profile status was changed to active; Auth ban was
removed via the admin API, and a random TEST password was assigned.

Password login through the normal `localhost:3001/login` server action succeeded,
and the existing session loaded its three questions, image and pins. Session access
also succeeded after refresh. No answer was entered and no AI/question action was
executed. TEST refinement and other AI settings remain disabled.

The browser tool's automatic snapshot initially exposed a temporary password.
That value was immediately invalidated by rotation. A fresh credential was then
transferred locally and submitted in one operation without returning the login
fields. The temporary owner-only credential file and transfer server were removed.
The final password is not retained; the verified browser session remains signed in.
Re-login after losing that session requires a separately approved credential reset.

Before/after fingerprints confirm that research tables, other profiles/Auth users
and compared Storage listing are unchanged. Production's compared catalog and
eleven Auth/research/Storage fingerprints are unchanged. Protected prompts,
schema and existing migrations are unchanged. Auth/profile count remains three;
only the target is activated. Normal login metadata/activity updates may affect
that target account.

Account/login preparation is complete. Full answer/refinement E2E still requires
separate approval, TEST-only refinement configuration and an explicit maximum-one
live-call guard. The current TEST runtime uses a source snapshot; restart it before
E2E to include subsequent source/UI edits.

#### Phase 3-D-3.2-D: Sentence Refinement browser E2E

Completed on TEST `njtgxnlxlhxpbiekbgmv` using the existing synthetic account and
session. The latest source snapshot retained the login session after restart.
`npm run dev:test -- --refinement-e2e` enables only refinement in that snapshot;
Production source and env files are not modified. An injected SDK fetch validates
the exact approved synthetic text, model, prompt hash, `store:false`, `stream:false`
and endpoint before consuming `.test-runtime/refinement-e2e-call` with atomic
exclusive file creation. That persistent marker is never automatically reset:
concurrent workers/restarts/provider failures cannot initiate a second Responses
request. Tests cover invalid requests, concurrent calls, reloading the guard and
network failure. Other AI model settings remain empty/disabled.

The actual browser flow passed: first answer autosaved, one live refinement
completed and persisted without changing the original, undo saved the original
selection while preserving the refined text, reload/question re-entry restored
both, and a separate second answer remained attached to its own question.
Final answer count is two; the third question has no answer.

Live request: `gpt-6-astra`, HTTP 200/completed, 5124 ms, 463 input / 86 output /
549 total tokens, SDK retry zero. The output preserved uncertainty and both the
many-buttons concern and the fewer-buttons discoverability concern, without adding
facts, recommendations or evaluation. Duplicate click/navigation were disabled
during loading. Empty refinement was disabled in the browser; stale/auth/completed
and save failure defenses were verified by mock regression, not additional live
calls. Full regression: 212 PASS, 0 FAIL, 1 native opt-in SKIP; lint/typecheck/build
passed. UI hidden labels, neutral text action, zero icon/text gap, visible panel
overflow, textarea-only scrolling, image and pins remained intact; exceptionally
long question/layout cases remain covered by mock tests.

Production's compared DB catalog and eleven Auth/research/Storage fingerprints
remained unchanged. All fourteen protected prompt/schema/migration files and both
env files remained unchanged. After validation the TEST server was restarted in
normal all-AI-disabled mode. The consumed budget marker/result remain as evidence;
do not delete/reset them to retry. No extra live calls or question actions occurred.

Above 1000px, both result cards share a `clamp(34rem,65dvh,44rem)` minimum height.
Compact question/answer content and an auto-sized status area do not scroll inside
the right card; exceptionally long questions expand both cards together.
Top-right numbered navigation remains beside the question count.
Previous/next arrow buttons are omitted; keyboard arrows outside
the answer editor still navigate questions. Narrow screens horizontally scroll
the numbered controls when needed, preserving their hit areas. The image stage
uses its available dimensions and the original aspect ratio; pins remain relative
to the displayed image frame. Thumbnails scroll horizontally in their own row.
At tablet/mobile widths, the desktop height is released and the editor can expand
vertically. `tests/fixtures/question-result-layout.mjs` serves synthetic static
renders of the real component and CSS on loopback only for browser measurements;
it does not use hosted credentials, write answers, or call any AI provider.
Run `node tests/fixtures/question-result-layout.mjs`, open the printed loopback
URL, and run `await globalThis.verifyQuestionResultLayout()` in the browser
console at each target viewport to compare the synthetic variants.

The image picker displays all registered session images, not only the current
question's targets. Selecting an image preserves the question selection; question
navigation and pins continue to use persisted target associations. Browsing controls
remain available for read-only results while answer editing stays disabled.
Questions whose targets all cover whole images appear as numbered circles along
the top-left edge of every image, centered on its upper boundary. Selecting such
a question opens the first session image and highlights its circle; region-target
questions retain their persisted coordinate pins. This is a display-only behavior
and does not change stored target associations.
Inactive image pins use white in light mode and black in dark mode; the active
pin retains its orange highlight.

`npm run test:question-ui` covers answer input and navigation under React Strict Mode,
including selecting session images unrelated to the current question.

### Phase 3-D-2 / 3-D-2.1: question actions

Action responses validate the complete view and activity flag. If another tab
replaces a slot after an acknowledged action, a strictly newer regeneration
index reconciles the authoritative active version without consuming another
candidate. Same-index mismatches remain blocked for explicit request recovery.

`20261009002000_question_actions.sql` was applied to Production `question`
(`jaqyzbrvufknpsbcuqzw`) on 2026-10-09 after explicit approval.
Catalog verification matched all four function bodies to the approved file,
confirmed constraints/indexes/grants/RLS, and found unchanged row counts and
fingerprints for answers, questions, candidates, targets, sessions, events and
generation attempts. No question action or live OpenAI call was executed.
Browser mutation verification still requires separate approval; Production had
zero unused reserves at this verification point. The project has no
`supabase_migrations.schema_migrations` ledger, so installed catalog objects
were verified directly rather than claiming a recorded migration version.
The authenticated capability read explicitly reports unavailable when its RPC is
not installed; both mutation actions stay disabled, with an explanation. The
server refuses writes before constructing a trusted client in this case.
No OpenAI configuration or model activation is part of this feature.

Skip and reserve replacement use one
trusted atomic RPC. The server authenticates the caller; the RPC independently
checks active participant ownership, session state, active question, and answer
revision under a session lock. Nonempty original or refined text blocks both
actions, as required by the existing DB and Locked Decisions. Empty answer rows
remain attached to their original question ID, never a replacement ID.
Skip retains the question, targets and optional existing empty answer, and records
an immutable event. The UI advances to the next unprocessed active slot, retaining
all slot numbers and allowing read-only revisit of skipped questions.
Skipped-question guidance appears in the disabled answer's placeholder instead
of the question body, explicitly explaining that input is unavailable and records
are retained. Disabled answer fields use stronger theme-specific gray backgrounds
and borders with readable placeholder text in both light and dark mode.
The skipped placeholder is "건너뛴 질문이며 답변을 입력할 수 없습니다.";
both question actions are disabled on skipped questions, with no regeneration
tooltip. Dark disabled fields use neutral translucent white, without a focus glow.

Regeneration takes the lowest-ranked unused reserve from the original completed
attempt. It is a **reserve replacement**, not a new AI generation. The previous
version becomes inactive without changing its content, targets or answer. The new
ID keeps the root, previous parent, slot and incremented regeneration index, with
candidate FK and deterministic selection reason. Targets come only from that
candidate and its authoritative image snapshot. Candidate rank is never treated
as a slot. No candidate is reused; each slot allows at most two replacements.
Skipped versions may be replaced without changing their skip record. N=5 and
exhausted reserves explicitly disable regeneration; there is no AI fallback.
Unavailable regeneration remains focusable and clickable for explanation only:
its native hover tooltip describes the blocking reason, and clicking announces
the same reason in a repeatable toast without a mutation request. Written-answer,
reserve and replacement-limit explanations no longer occupy the panel body.
During navigation, refinement or an action request the button remains disabled.
Available actions use black text/icons in light mode and white in dark mode,
with neutral gray hover backgrounds. Unavailable explanatory buttons have no
hover background. The visible refinement label is "문장다듬기".

The request ledger and event are committed with the question change. The UI
flushes all pending answer saves before mutation, locks navigation/refinement,
and retains the same request ID after transport/ambiguous failures for manual
retry only. An invalid or stale response is not applied. Success refreshes all
active questions and targets together, keeps the replacement slot (or advances
after skip), and places focus on the question header. The result read now selects
active original/regenerated versions, not the immutable originals alone.
The numbered navigation remains at the top-right as most recently requested;
the attachment's older bottom-arrow illustration is not restored.

Question actions sit below the question as small text buttons.
Both question actions retain theme-aware secondary text even when disabled,
overriding the generic disabled-button white text. "질문 건너뛰기" has a
decorative forward-arrow icon alongside regeneration's icon.
Sentence refinement is also a text action with a small icon, not a filled submit-like
button. Existing autosave, refinement gating, preservation and undo remain.
Refinement is still disabled unless separately configured and approved.
The answer's accessible name remains "나의 생각" without a visible label.
Idle saved status has no visible text; saving and failure notices remain.
Unavailable question-action setup is announced through the existing
auto-dismissing toast instead of an inline paragraph.
Sentence-refinement activation/configuration errors also use an auto-dismissing
toast rather than inline footer text. The history link is labelled "나의기록으로".
The question count uses the theme's muted text color.
Refinement permission errors use the same toast treatment. Question body text
uses the existing semibold (600) weight.
Sentence refinement is underlined, black in light mode and white in dark mode,
including its disabled state. It sits 4px higher and enabled hover uses 75%
opacity without a background box; reduced-motion preferences disable the transition.
Image pins retain their size and numeral font with a 2px border and active ring.
Whole-image pins along the upper-left image edge use an 8px gap.
Compact panel spacing avoids nested content and
footer scrolling; long answers scroll inside the textarea. The desktop cards
retain their shared minimum height, but grow together for exceptionally long
questions or notices rather than clipping content or introducing a panel scrollbar.

## Phase 3-D-4-B: local-only single-question regeneration

The approved policy and earlier architecture review are recorded in
[QUESTION_REGENERATION_API_DESIGN.md](./QUESTION_REGENERATION_API_DESIGN.md#13-phase-3-d-4-b-확정-정책-및-구현-경계).
The new regeneration prompt/schema are separate `v1.0` contracts; the original
five-candidate generation and frozen Context Draft/Refinement prompts are unchanged.

- Use unused Reserve candidates first. Only exhaustion permits a single new
  provider-generated question.
- At most three durable provider dispatches per session, including failures,
  timeouts and uncertain outcomes. Merely reserving a request does not charge.
  At most two successful replacements per question slot, counting both methods.
- Authenticated owning active Participants only; completed sessions remain read-only.
  Empty answer rows and unanswered skipped questions may regenerate. Any authored
  original or refined text blocks regeneration. Existing skipped events and old
  question/target/answer associations are retained; answers never move to a new question.
- `OPENAI_QUESTION_REGENERATION_ENABLED` defaults off and uses its own
  `OPENAI_QUESTION_REGENERATION_MODEL`, never the initial-generation model as a fallback.
  The default TEST launcher explicitly disables regeneration too.
- The existing question-action POST uses durable admission/dispatch/stage/commit
  when enabled. Same-ID replays do not start a second provider call. GET recovery
  reads status or commits an already-staged candidate without generating.
  The feature remains unavailable without the separately approved additive migration.
- SDK retries are zero, `store:false`, provider deadline 60 seconds. Browser
  recovery uses bounded GET polling, retains the existing question/pin until commit,
  and offers same-request result checking after an ambiguous response or reentry.
- A stopped process cannot guarantee provider completion. Reserved expiration
  is distinguished from dispatched `outcome_unknown`; neither automatically
  re-dispatches. No worker deployment or remote recovery job is installed.
- Deterministic exact/3-gram Dice screening (threshold 0.82) supplements the
  prompt's different-perspective instruction. It is **not** proof of semantic
  uniqueness; Korean paraphrase quality remains a separate TEST/live approval check.

This phase permits local implementation and mock/disposable PostgreSQL validation
only. The additive migration has **not** been applied to TEST or Production.
No live model invocation or remote research-data mutation is authorized here.
Before deployment, separately approve the TEST migration, verify catalog/RLS/data
integrity, then approve mock browser, single-call live validation and browser E2E.
Keep the feature off until those gates pass.

The newly written migrations must be applied in this order, **only after separate
approval**:

1. [20261010001500_question_regeneration.sql](./supabase/migrations/20261010001500_question_regeneration.sql):
   request/attempt/candidate/event ledgers, private snapshots, guards, capabilities
   and Reserve/API atomic replacement RPCs.
2. [20261010002000_regeneration_dispatch_provenance.sql](./supabase/migrations/20261010002000_regeneration_dispatch_provenance.sql):
   immutable private dispatch provenance and the server's metadata-bearing dispatch
   overload. Model/prompt/schema/screening version are recorded atomically with
   authorization, including requests that later fail or become outcome-unknown.

Database lifecycle names `completed`/`dispatch_unknown` are normalized by the
repository into HTTP `committed`/`outcome_unknown`; snapshots remain server-private.
Reserved leases expire after 120 seconds without charging; dispatched leases expire
after 90 seconds into unknown status with the charge retained. A staged candidate
does not expire into a redispatch.

Local Phase 3-D-4-B validation: **250 tests, 249 PASS / 0 FAIL / 1 SKIP**.
The one skip is the pre-existing opt-in initial-generation native suite; the new
regeneration native suites did run against fresh, disposable PostgreSQL 17
loopback clusters, including independent-connection admission/dispatch/answer/
completion races, commit rollback, unknown recovery, and dispatch-provenance
privacy/immutability. Mock service, actual SQL-backed repository integration
(Reserve replay, repeated candidate-stage replay, distinct slot/session limits
and stale-error persistence), UI polling/reentry, Skip, Reserve, autosave and
refinement regressions passed.
Lint, typecheck and production build passed. All 14 protected prompts/schema/
existing migrations and both existing environment-file hashes remained unchanged.
Actual provider calls and remote TEST/Production DB/Auth/Storage writes were zero.

## Phase 4-C: completion and briefing server APIs

## Phase 4-E: participant diaries and admin session review

The completed-session briefing includes the fixed Q1/Q2 diary choices and optional Q3 free text
from `WHY_BOX_SPEC.md` section 36. The prompt appears once per completed session after the
briefing has remained open for ten seconds; leaving the briefing cancels the timer. Participants
can reopen it manually. Unsubmitted input is retained in that browser's session-specific
localStorage draft; submitted diaries are read-only. The existing `diaries` table, RLS and
`claim_session_diary_prompt` RPC are reused without a migration.

Admin participant records link to read-only session detail pages containing design context,
question/answer provenance, skip and question event history, briefing source and revisions,
briefing request status, and submitted diary content. Access remains behind the existing active
admin role check and table RLS. Run `npm run test:diary` for the diary contract and view checks.

- `POST /api/sessions/{sessionId}/complete` accepts a UUID `request_id` and an
  optional `retry_of_request_id`. It returns the durable request state, missing
  question IDs when blocked, and an explicit `provider_mode`; request snapshots
  remain server-private. Replaying the same request ID does not dispatch again.
- `GET /api/sessions/{sessionId}/briefing` returns the immutable generated source,
  the latest participant revision (or source text at revision `0`), and its
  revision timestamp. Active Admins may read; only the owning active Participant
  may edit.
- `PATCH /api/sessions/{sessionId}/briefing` accepts `expected_revision` and
  `briefing_text`. The database CAS RPC appends a revision or returns HTTP 409
  with the current revision. The source and completed answers remain unchanged.
- This phase originally wired only a deterministic provider labelled
  `WHY-BOX-LOCAL-MOCK`. The local production-readiness update now also wires
  the opt-in OpenAI provider described at the top of this document.
  It is enabled by the isolated `npm run dev:test` runtime only when its
  environment identifies the exact TEST Supabase project. Production `NODE_ENV`
  and all other Supabase project refs block Mock generation.
- The Phase 4-B migration is a prerequisite for these routes and must be applied
  separately with explicit environment approval. This implementation does not
  apply it to TEST or Production. Participant completion/briefing/diary and Admin
  review UI now exist (see Phase 4-E), but the Production live provider is still missing.

## Pretendard font

The global font stack prioritizes Pretendard and falls back to system sans-serif. No font binary is bundled in Phase 1; add an appropriately licensed local Pretendard webfont before deployment if the exact font is required.
