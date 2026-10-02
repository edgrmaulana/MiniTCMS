# Migrating off TestRail

Two entry points of equal weight: the API v2, and a case CSV export.
Pick by what your TestRail admin will give you.

| You have | Use | Brings |
|---|---|---|
| An API key | `npm run migrate` | Projects, suites, sections, cases, custom fields, milestones, plans, runs, tests, results, users |
| Only a CSV export | `npm run migrate:csv` | Projects you name, suites, sections, cases, custom fields |

Both are idempotent and both print the same report. Neither ever deletes
anything to make an import work.

## The API path

### 1. Get a key

TestRail issues one per user under *My Settings → API Keys*. It is not
the account password, and the API has to be switched on for the instance
under *Administration → Site Settings → API*. The key inherits the
permissions of the account it belongs to, so use an account that can read
every project you intend to move.

Credentials come from the environment only. Locally that is `.env.local`:

```bash
TESTRAIL_HOST=https://example.testrail.io
TESTRAIL_USER=you@example.com
TESTRAIL_API_KEY=...
TESTRAIL_RPS=5
```

`TESTRAIL_RPS` throttles the client. TestRail's cloud plans rate limit,
and the import is tens of thousands of calls; 5 is a polite default.
Nothing but the import reads these three.

### 2. Dry run first

```bash
npm run migrate -- --dry-run
```

A dry run does the whole import inside one transaction and rolls it back,
so it reads your instance for real and writes nothing. It records itself
as source `testrail:dry-run` and writes no cursor — a rolled-back step
must not look done to the next resume.

Start smaller than the whole instance:

```bash
npm run migrate -- --dry-run --project 42      # one TestRail project id
npm run migrate -- --dry-run --project 42,51   # a few
```

### 3. Read the report

The report is the deliverable, not a log line. `counts` has to reconcile
per entity — `fetched` equals `inserted + updated + unchanged + skipped`,
or the import fails with `RECONCILIATION FAILED` and says which entity
could not be accounted for.

```text
counts
  projects     fetched 3, inserted 3, updated 0, unchanged 0, skipped 0
  suites       fetched 7, inserted 7, updated 0, unchanged 0, skipped 0
  cases        fetched 1041, inserted 1041, updated 0, unchanged 0, skipped 0

unmapped (2)
  cases 1041 custom_browser: Firefox ESR
  cases 1042 priority_id: TestRail id 7 has no label we recognise

notes
  attachments were not fetched: ...
  every imported user got the "tester" role; TestRail's role ids do not map to ours
```

- **unmapped** — a value that was not translated: a custom field kept
  verbatim in the `custom` JSON column, or an id with no label we
  recognise, which lands as `NULL` with the source id named. Nothing is
  lost and nothing is guessed, but a column full of `NULL` priorities is
  something to fix and re-run rather than live with.
- **skipped** — a row the importer declined to understand, with the
  reason and the source id. The API path has nothing that skips; a CSV
  skips a non-empty `Attachments` cell, because a filename without its
  bytes is not an attachment.
- **errors** — the import stopped. One entry, the failure that ended it,
  and the report is printed before the process exits non-zero.
- **notes** — what the import wants you to tell someone: that attachments
  were not fetched, that every imported user landed on `tester`, that a
  custom field type it did not recognise was preserved verbatim.

Each list stops at 1000 entries and then counts the rest, so a 200k-case
import with one unmapped field per case still reports its true size
without holding it all in memory.

### 4. Run it

```bash
npm run migrate
```

It prints each step as it goes, then the report, then the import run id.

### 5. Resume, if it dies

Every step is checkpointed by name in `import_runs.cursor`, so a resume
skips what already landed rather than re-reading the instance:

```bash
npm run migrate -- --resume 3
```

The id is the one the failed run printed; `GET /api/migrate` lists them,
newest first, and `GET /api/migrate/[id]` has the state, cursor progress
and report of one. A finished run refuses to resume.

Running the same import twice is safe either way: every imported row
carries `(source, source_id)` with a unique index and import is an upsert
on that pair, so a second pass reports zero inserts.

## The CSV path

A CSV needs no plan tier and no admin willing to issue a key, so it is
what a team can always produce. Export cases from the case list view,
with columns, not the steps template.

```bash
npm run migrate:csv -- export.csv --project 1 --tz Asia/Jakarta \
  --date-order mdy --dry-run
```

Three of those flags have no defaults, because the file cannot say:

- `--project` — no column holds it, and it is not inferred from a suite
  name. Create the project first, or import one into it from the API.
- `--tz` — `"10/1/2026 6:26 PM"` carries no offset.
- `--date-order mdy|dmy` — `1/2/2026` is January 2nd or February 1st
  depending on the exporting user's account settings. Guessing moves
  every date in the import by up to eleven months, silently, so the
  import refuses to start without it.
- `--users "ana=ana@example.com,bob=bob@example.com"` — optional. A CSV
  has display names where the API has emails. A name resolves only on a
  unique match; anything else leaves the column `NULL` and reports it.

The same screen is at `/migrate` for admins: upload, dry run, read the
report, see every past import.

## Do not run both into one project

`UNIQUE(source, source_id)` is per source, and `testrail` and
`testrail-csv` are different sources — a CSV import followed by an API
import into the same project would land **every case twice**, and the
schema cannot see it. Both importers refuse a project that already holds
rows from the other source and name it, unless you pass
`--allow-mixed-sources` and mean it.

Evaluate with the CSV, then start the real API import on a fresh project.

## What does not come across, and why

- **Attachments.** The API path does not fetch them — not the bytes and
  not the rows. The bytes are a second call per attachment and a disk
  budget nobody has set a number for, and a row without its file is a
  broken link, so the stage is not built and every import says so in its
  report. A CSV never had the bytes at all, so a non-empty `Attachments`
  cell is a reported skip naming the case.
- **Steps-template CSV exports**, which spread one case over several
  rows. A file with any `Steps (…)` column filled refuses to import
  rather than reading half of it. The API path carries steps fine.
- **`suite_mode` 2 baselines.** The flag carries over; `baseline_of`
  stays `NULL` and is reported, because `get_suites` does not say which
  suite a baseline came from.
- **Roles.** Imported accounts land on `tester`. TestRail's role ids are
  instance-specific and its permission model is not ours, so the import
  takes least privilege and reports it; promote whoever needs it.
- **Passwords.** Imported users have no password hash and cannot sign in
  until an admin sets one. They exist so results attribute to the person
  who recorded them.
- **Anything TestRail did not send** is `NULL`, never a placeholder. An
  unknown priority label does not quietly become "other"; a result with
  an unknown status stops the import.

## After the import

```bash
# An account you can sign in with, if you are not importing one.
npm run user:add -- you@example.com admin

# A key for CI. Printed once.
npm run key -- add ci@example.com "github actions"
```

Reporting results from CI is one call per run — see **Reporting from CI**
in [`README.md`](../README.md).

The deviations from TestRail's model, and why each one was taken, are in
[`plan/04-testrail-migration.md`](../plan/04-testrail-migration.md).
