# Phase 4 — TestRail migration

The reason this project exists. Everything else is a place to put the
data. Treat a lost field as a bug of the same severity as a crash.

Depends on phases 1-3. Blocks nothing — but nothing else matters if this
is wrong.

**Status: not started.** No client, no mapping, no pipeline. The one
thing already in place is the shape that makes it replayable: every
importable table carries `(source, source_id)` with a UNIQUE index, and
`users` already follows it.

Done when: a real TestRail instance imports twice in a row and the
second run reports zero inserts, zero updates, zero errors.

## 1. Client — `lib/testrail.ts`

One module. One `fetch`. Nothing else in the repo talks to TestRail.

- Base URL `${TESTRAIL_HOST}/index.php?/api/v2/${method}`. Note the
  `?/` — TestRail's URL shape is not a typo and query params append with
  `&`, not `?`.
- Auth: HTTP Basic, `TESTRAIL_USER` + `TESTRAIL_API_KEY`. API key, not
  password — document that in `README.md`.
- `getAll(method, params)` — the only list helper. TestRail 6.7+ returns
  `{ offset, limit, size, _links: { next }, <collection> }`; older
  versions return a bare array. Handle both: bare array means one page,
  done. Never assume 250 is everything.
- Retry: on 429 honour `Retry-After`; on 5xx exponential backoff, 5
  attempts, then fail loud with the method and params in the message.
- Throttle to a configurable requests/second (`TESTRAIL_RPS`, default 5).
  A full import of a large instance is tens of thousands of calls and
  getting the account rate-limited mid-import is the common failure.

## 2. Read order

Foreign keys force this order. The pipeline runs it top to bottom and
checkpoints after each stage.

```text
1  get_users                      -> users
2  get_statuses                   -> statuses       (custom ones, >= 6)
3  get_case_fields                -> case_fields
4  get_case_types, get_priorities, get_templates -> lookup tables
5  get_projects                   -> projects
   per project:
6    get_suites                   -> suites
7    get_milestones               -> milestones     (parents before children)
8    get_configs                  -> stored as text on runs
     per suite:
9      get_sections               -> sections       (parents before children)
10     get_cases                  -> cases
11   get_plans, get_plan(id)      -> plans
12   get_runs                     -> runs
     per run:
13     get_tests                  -> tests
14     get_results_for_run        -> results
15 attachments for cases/tests/results -> attachments
```

Sections and milestones both nest: sort by `parent_id IS NULL` first,
then insert iteratively until no row is left — a parent is always
written before its children or the FK rejects it.

## 3. Mapping — `lib/migrate/map.ts`

One pure function per entity: `mapCase(testrailCase, context) -> Row`.
Pure means testable with a JSON fixture and no network. Every one of
them has a fixture test.

Known translations:

- **ids** never carry over. Write `source = 'testrail'`,
  `source_id = tr.id`, and resolve parents through
  `lookupId('cases', trId)` against the same pair. Keep the lookup in
  one in-memory `Map` per import for speed, backed by the DB so a
  resumed import can rebuild it.
- **statuses** 1-5 are identical by construction (phase 1). Custom
  statuses (>= 6) import as `statuses` rows first; a result referencing
  an unknown status fails loud rather than defaulting to untested.
- **suite_mode**: 1 single, 3 multi map straight. Mode 2
  (single + baselines) imports each baseline as a suite with
  `is_baseline = 1` and `baseline_of` pointing at the master. Confirm
  against a real mode-2 instance before shipping.
- **custom fields**: `custom_*` keys on a TestRail entity strip the
  prefix and land in `custom` JSON. `custom_steps_separated` maps to
  `custom.steps` unchanged — the shapes were chosen to match in phase 2.
- **users** resolve by email, not by id or name. A result from a deleted
  TestRail user keeps `created_by = NULL` and is counted in the report;
  it is never reassigned to anyone.
- **HTML/markdown**: TestRail stores a markdown dialect. Store verbatim.
  Rendering is the UI's problem; rewriting user content during a
  migration is how data gets silently mangled.
- **dates** are unix seconds in TestRail. Store as unix seconds. No
  timezone guessing.

Anything with no mapping goes to `report.unmapped` with entity type,
source id and field name. Nothing is dropped quietly.

## 4. Pipeline — `lib/migrate/run.ts`

- One `import_runs` row per import: `state` in
  `pending|running|failed|done`, `cursor` JSON, `report` JSON.
- `cursor` records the last completed stage and the last completed
  `(project_id, suite_id, run_id)`. Resume reads the cursor and skips
  forward — it never re-reads from stage 1 and never deletes.
- Every write is an upsert:
  `INSERT … ON CONFLICT(source, source_id) DO UPDATE SET …`. Idempotency
  comes from the schema, not from checking first.
- Batch inserts inside one transaction per batch (500 rows). A
  transaction per row makes a 200k-case import take hours.
- Results are the big table. Import them per run, newest run first, so a
  partial import is still useful.
- `--dry-run` reads everything, maps everything, writes nothing, and
  prints the full report. This is how a migration gets reviewed before
  it happens.

## 5. The report

Printed to stdout and stored in `import_runs.report`:

```text
source counts   per entity: fetched from TestRail
written counts  per entity: inserted / updated / unchanged
unmapped        entity, source_id, field, raw value
skipped         entity, source_id, reason
errors          entity, source_id, message
duration        per stage
```

Counts that do not reconcile (fetched != inserted + updated + unchanged
+ skipped) are a hard failure, not a warning. A migration that cannot
account for every row has not succeeded.

## 6. CSV fallback

Not every TestRail plan exposes the API. A second entry point reads
TestRail's CSV case export into the same `mapCase` function:
cases only, no runs or results, `source = 'testrail-csv'`. Build it
after the API path works and only if the API path is not enough — this
is the first thing to cut if phase 4 runs long.

## 7. Interfaces

- CLI: `npm run migrate -- --dry-run`, `npm run migrate -- --resume`,
  `--project <trId>` to scope a trial import. The CLI is the real
  interface; it is what a self-hoster runs in a terminal against a big
  instance.
- UI: `app/migrate/` wraps the same functions — credentials form, a
  dry-run preview, start, live progress from `import_runs`, and the
  report. The UI never reimplements the pipeline.

## 8. Tests

Fixture-driven, no network:

- `map.test.ts` with one anonymised JSON fixture per entity, taken from
  a real instance with names and emails replaced.
- Nested sections out of order still insert parents first.
- Running the same fixture import twice: second pass reports zero
  inserts and zero updates.
- A result with an unknown `status_id` fails loud.
- A custom field of an unsupported type lands in `report.unmapped` and
  the row still imports.
- Resume: kill after stage 9, resume, assert stages 1-9 are not re-read
  and the final state matches a clean import.

Client tests mock `fetch`: pagination over three pages, a 429 with
`Retry-After` honoured, a bare-array response from an old version.

## 9. Checks

`npm run test`, `npm run lint`, `npm run build`. Plus one real dry-run
against a live instance before calling the phase done — fixtures do not
catch a wrong URL shape.
