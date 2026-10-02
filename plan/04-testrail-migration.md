# Phase 4 — TestRail migration

The reason this project exists. Everything else is a place to put the
data. Treat a lost field as a bug of the same severity as a crash.

Depends on phases 1-3. Blocks nothing — but nothing else matters if this
is wrong.

**Status: done, bar attachments.** Both entry points ship: the API
v2 client with its pipeline, and the CSV reader with its own. 97 new
tests. Schema v9 added two indexes, both after measuring.

Review found six defects in the first cut, four of them reproduced
against a database before being fixed and all six with a test:

- A source row carrying no creation date fell back to the clock, and the
  clock was in the update comparison - so the row reported "updated" on
  every import and its stored dates walked forward each time. A CSV with
  no `Created On` column rewrote all 243 timestamps on the second pass.
  Both entry points had it. `created_on` is now written once and never
  compared; an absent modification date keeps whatever is stored rather
  than inventing one.
- `suite_id` was sent on `get_cases` and `get_sections` for every
  project. TestRail documents it as optional in single-suite mode -
  its default - and rejects the call outright on some versions. Now
  omitted for mode 1.
- Two sibling sections with the same name, which TestRail allows,
  resolved to whichever row SQLite returned last. Ordered by id now, and
  the first one wins.
- The section path key joined segments with a newline, which a CSV cell
  can contain. JSON now, so the key cannot be ambiguous.
- A failed CSV import stored a report holding only the error message,
  discarding every count and note it had collected - the one outcome
  `import_runs` exists to prevent.
- A TestRail comment-only result landed holding `untested`, which
  everywhere else in this product means "no result exists", with nothing
  said about it. Reported now.

Verified end to end, twice each. The CSV path ran against the real
243-case export this project was handed: 243 cases, 56 sections and 15
custom fields in 69ms, and a second pass reporting zero inserts and zero
updates. The API path ran against a fake TestRail speaking the real URL
shape, including `_links.next` pagination over three pages and a 429
with `Retry-After` — same result on the second pass. **No real TestRail
instance has been imported yet**, which is the one line of section 9
still outstanding; a fake server catches a wrong URL shape but not a
column an instance has that nobody anticipated.

| Section | State |
|---------|-------|
| 1 Client | done - `lib/testrail.ts`, throttle, 429, backoff, both page shapes |
| 2 Read order | done, bar stage 15 |
| 3 Mapping | done - one pure function per entity in `lib/migrate/map.ts` |
| 4 Pipeline | done - `lib/migrate/run.ts`, checkpointed per step, `--dry-run` |
| 5 The report | done - `lib/migrate/report.ts`, reconciliation is a hard failure |
| 6 CSV import | done, bar 6.5 |
| 6.5 Steps-template exports | refused loud, as specified; needs a second real export |
| 7 Interfaces | `npm run migrate`, `npm run migrate:csv`, three routes; the UI is phase 5 |
| 8 Tests | done |
| 9 Checks | test, lint and build pass; the live-instance dry run is outstanding |

Three things are deliberately not built, each reported by every import
that touches them rather than left silent:

- **Attachments.** Neither the rows nor the files come across on the API
  path: the bytes are a second call per attachment and a disk budget
  nobody has set a number for, and an attachment row whose file was
  never fetched is a broken link in the UI. Stage 15 below is the
  unbuilt stage, and every import carries a note saying so. The CSV path
  reports each non-empty `Attachments` cell as a skip with the case id.
- **`suite_mode` 2 baselines.** `is_baseline` carries over and
  `baseline_of` stays NULL, because `get_suites` does not say which
  suite a baseline came from.
- **Imported roles.** TestRail's role ids are instance-specific and its
  permission model is not ours, so every imported account lands on
  `tester` and the report says so. Least privilege beats a guess that
  mints an admin.

One thing changed shape against the plan below. Section 4 describes the
cursor as "the last completed stage and the last completed
(project_id, suite_id, run_id)". What shipped is a set of completed step
keys - `users`, `project:10:suites`, `suite:20:cases`, `run:70:results`
- and a resume skips any step already in the set. It is simpler, it is
order-independent, and it resumes correctly when a project fails halfway
through a list of projects, which the tuple form does not.

Two entry points, equal weight: the API (sections 1-5) and a CSV case
export (section 6). The CSV is not a degraded mode — it is what a team
without API access can actually produce, and it was the first real
sample this project saw.

Done when: a real TestRail instance imports twice in a row and the
second run reports zero inserts, zero updates, zero errors; and a real
CSV export does the same.

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
  it is never reassigned to anyone. The CSV path has no email to resolve
  against and relaxes this under protest — see 6.2.
- **authorship** is four columns, not two: `created_by`/`created_on` and
  `updated_by`/`updated_on`. Schema v5 added `cases.updated_by` for it.
  Both entry points carry all four.
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

## 6. CSV import — `lib/migrate/csv.ts`

Not a fallback. Not the first thing to cut. A CSV case export is what a
team can always produce — API access needs a plan tier and an admin
willing to issue a key, and the first real sample this project was
handed was a CSV, not a JSON dump. Both entry points ship.

It is a different format, not a thinner one, so it gets its own reader
and its own mapper. `mapCsvCase` is a sibling of `mapCase`, not a
caller of it: the API sends ids, the CSV sends labels.

### 6.1 What the format is

Measured against a real 243-case export, not assumed:

- UTF-8, **CRLF**, RFC 4180 quoting with doubled quotes.
- **Fields contain newlines** — 241 of 243 rows did. Anything that
  splits on `\n` before parsing is wrong on row one. Use a real parser.
- **Header names repeat.** `Steps` appeared twice in a Text-template
  export. Address columns **by index**, never by a `Record<string,…>`
  built from the header row, or one of them is silently lost.
- Column set is not fixed: it is whatever the exporting user ticked,
  plus that instance's custom fields. Treat the header as data.
- Values are **labels**: `Priority` is `"Medium"`, `Type` is `"Other"`,
  `Template` is `"Test Case (Text)"`. No ids anywhere except `ID` and
  `Suite ID`.

### 6.2 What the CSV cannot tell us

Each of these is a decision, and rule 4 says none of them gets a
guessed default. Every one is either an operator input or a NULL plus a
line in the report.

| Missing | What happens |
|---|---|
| **Project** | No column exists. The operator names the target project, or passes `--project <id>`. Not inferred from the suite name. |
| **Timezone** | `Created On` is `"10/1/2026 6:26 PM"` — locale-ordered, 12-hour, no offset. The operator passes `--tz` and `--date-order mdy\|dmy`; without both, the import refuses to start rather than guessing which of the two dates in `1/2/2026` is the month. |
| **User identity** | `Created By` is a display name (`"edgar"`), not an email. Names resolve against existing `users.name` only on an exact unique match; anything ambiguous or unknown leaves `created_by`/`updated_by` NULL and lands in `report.unmapped`. A `--users name=email,…` map is the explicit override. |
| **Section ids** | Only a path string. See 6.3. |
| **Custom field definitions** | No `get_case_fields` equivalent. See 6.4. |
| **Attachments** | The column holds filenames at best; the bytes live behind the API. Every non-empty value is a `report.skipped` line with the case id. Never silently dropped, never faked. |
| **Runs, results, plans, milestones** | Not in a case export at all. Cases only. |

### 6.3 Sections from a path

`Section Hierarchy` is `"root > child > leaf"`, with `Section` holding
the leaf and `Section Depth` holding the 0-indexed depth. On the sample,
`depth == segments - 1` and `segments[-1] == Section` held for all 243
rows.

- Split on `" > "`, then **assert both invariants per row** and fail
  loud with the case id when either breaks. The separator is ambiguous
  if a section name contains it; the invariants are the detector, and a
  wrongly split path silently reparents a whole subtree.
- Build the distinct path set first, insert shortest-first so a parent
  always precedes its child, then insert cases.
- Reject `depth >= MAX_SECTION_LEVELS` loud. The schema CHECK would
  reject it anyway; catching it in the mapper names the case id.
- Sections carry no source id, so `(source, source_id)` cannot key
  them. Idempotency is on the **resolved path within the suite**: the
  importer keeps a `Map<path, sectionId>` and looks up before
  inserting. A second run of the same CSV creates no sections.

### 6.4 Custom fields from column headers

- Every column that is not one of TestRail's built-ins is a custom
  field. Slugify the header to a `system_name` (`Business_Unit` →
  `business_unit`) and upsert a `case_fields` row with
  `type = 'text'`, `source = 'testrail-csv'`.
- `text` is honest, not lazy: a CSV cell carries no type, and inventing
  `dropdown` from the distinct values seen would be inventing data. An
  API import later corrects the definition in place, keyed on
  `system_name`.
- Values land in `cases.custom` under that `system_name`, verbatim.
  Empty string imports as absent, not as `""`.
- TestRail's standard text-template fields are the exception and map to
  the names phase 2 already uses: `Preconditions` → `custom.preconds`,
  `Steps` → `custom.steps_text`, `Expected Result` → `custom.expected`.

### 6.5 Steps-template exports

Not covered by the sample, so it is built against a second export
before the phase is called done. A Steps-template export repeats the
case across **several rows**, one per step, with
`Steps (Step)` / `(Expected Result)` / `(References)` filled and the
other columns repeated or blank.

- Group rows by `ID` in file order, fold the step columns into
  `custom.steps` as `{ content, expected, refs }` — the same shape
  `custom_steps_separated` lands in from the API.
- A repeated `ID` whose non-step columns disagree between rows is a
  hard error, not a last-write-wins.
- Until that second export exists: a file with any `Steps (…)` column
  non-empty refuses to import, with the reason. Half-reading a steps
  export is worse than declining it.

### 6.6 Labels to ids

`lib/migrate/map.ts` owns this, same as the API path:

- `Priority` and `Type` match `CASE_PRIORITY` / `CASE_TYPE` on a
  case-insensitive label match. No match is **not** a silent `other` —
  the row imports with a NULL and a `report.unmapped` line naming the
  label, so the operator can add it and re-run.
- `Template` maps `"Test Case (Text)"` → `CASE_TEMPLATE.text`,
  `"Test Case (Steps)"` → `.steps`, `"Exploratory Session"` →
  `.exploratory`. An unknown template name is a hard error: it decides
  how the step columns are read.
- `ID` is `C7104597` → `source_id` 7104597; `Suite ID` is `S928` → 928.
  Strip exactly one leading letter and require digits after it.

### 6.7 Running it alongside the API import

`source = 'testrail-csv'` and `source = 'testrail'` are distinct, and
`UNIQUE(source, source_id)` is per-source — so importing a CSV and then
the API would land **every case twice**. This is the trap the schema
does not catch.

- The importer refuses to run when the target project already holds
  rows from the other source, and says which one, unless
  `--allow-mixed-sources` is passed.
- The documented path is CSV first to evaluate, then
  `npm run migrate -- --reset-project <id>` before the real API run.
  Documented in `README.md` the turn it ships.

### 6.8 The report

Same reconciliation rule as the API path: rows parsed must equal
inserted + updated + unchanged + skipped, or the import is a failure.
Plus, specific to CSV: the header columns recognised, the columns
treated as custom fields, and the sections synthesised.

## 7. Interfaces

- CLI, API path: `npm run migrate -- --dry-run`,
  `npm run migrate -- --resume`, `--project <trId>` to scope a trial
  import. The CLI is the real interface; it is what a self-hoster runs
  in a terminal against a big instance.
- CLI, CSV path:
  `npm run migrate:csv -- <file> --project <id> --tz <zone> --date-order mdy`,
  plus `--dry-run`, `--users <map>`, `--allow-mixed-sources`. Same
  report, same reconciliation rule.
- UI: `app/migrate/` wraps the same functions — a credentials form for
  the API, a file upload for the CSV, a dry-run preview, start, live
  progress from `import_runs`, and the report. The UI never
  reimplements the pipeline. The CSV upload is the easier of the two to
  ship and is the one a first-time evaluator reaches for.

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

CSV tests run off a small hand-written fixture that reproduces the
traps the real export has, in `lib/migrate/csv.test.ts`:

- A quoted field containing CRLF, a comma and a doubled quote parses to
  one value.
- A header with `Steps` twice keeps both columns distinct.
- `"a > b > c"` with `Section Depth` 2 builds three sections, parents
  first; a second pass over the same file adds none.
- A row whose depth disagrees with its segment count fails loud and
  names the case id.
- A path 7 levels deep is rejected against `MAX_SECTION_LEVELS`.
- An unknown `Priority` label imports the case with NULL and one
  `report.unmapped` line — it does not become `other`.
- A missing `--tz` refuses the import.
- A non-empty `Attachments` cell produces a `report.skipped` line and
  the case still imports.
- A file with a `Steps (Step)` column refuses, until 6.5 is built.

The fixture is written by hand from the shapes documented in 6.1. A
real customer export is never committed — it carries live endpoints,
traffic volumes and staff names, and this repo is public (AGENTS.md
rules 11 and 15).

## 9. Checks

`npm run test`, `npm run lint`, `npm run build`. Plus one real dry-run
against a live instance and one against a real CSV export before
calling the phase done — fixtures do not catch a wrong URL shape, and
they do not catch a column the exporting user ticked that nobody
anticipated.
