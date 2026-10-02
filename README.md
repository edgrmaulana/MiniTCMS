# MiniTCMS

Open-source test case management, self-hosted, built to receive a
migration from TestRail.

Next.js 16 + SQLite. One process, one database file, one container.

## Status

Usable end to end: sign in, import a case CSV from the import screen or a
whole TestRail instance from the CLI, browse the case tree, edit a case, then
open a run and record pass, fail, retest or blocked against every test from
the keyboard. The dashboard says how much of a project has been executed and
what was recorded last. A CI job gets an API key and reports results by case
id in one call. Creating projects, suites and runs is still an API call -
those forms are the next cut.

| Phase | | |
|---|---|---|
| 1 | Foundation — SQLite layer, schema, constants, test harness | **done** |
| 2 | Case repository — projects, suites, sections, cases, custom fields | **done** |
| 3 | Execution — runs, pass/fail/retest/blocked, append-only results | **done** |
| 4 | TestRail migration — client, CSV reader, mapping, resumable import | **done**, bar attachments |
| 5 | UI — app shell and the five screens | **done** |
| 6 | Auth and public API — login, roles, REST API, CI reporters | **done**, bar user management |
| 7 | Release — Docker, CI, license, contributor docs | not started |

Each phase has its own file in [`plan/`](plan/), opening with its status
and a per-section breakdown. Start at [`plan/README.md`](plan/README.md).
Rules for working in this repo are in [`AGENTS.md`](AGENTS.md).

## Run

```bash
npm install

# Create the first account. The password is read from stdin, so it never
# lands in your shell history. Minimum 12 characters. The role defaults
# to tester, so ask for admin explicitly.
npm run user:add -- you@example.com admin

npm run dev          # http://localhost:3000/login
```

```bash
# A key for CI, printed once. Roles come from the owner, so a key can never
# do more than the account it belongs to.
npm run key -- add ci@example.com "github actions"
npm run key -- list
npm run key -- revoke 3
```

```bash
npm run test
npm run lint
npm run build
```
The screens, once an account exists:

| Path | What it is for |
|---|---|
| `/` | Dashboard — open runs, how much of the project is executed, recent results |
| `/cases` | Section tree and the case table: search, filter, multi-select, bulk move |
| `/cases/[id]` | One case: fields, step table, custom fields, explicit save |
| `/runs` | Every run in the project, open ones first, each with its status bar |
| `/runs/[id]` | The execution screen — results from the keyboard, see below |
| `/migrate` | CSV import with a dry run, the report, and every past import |

The project is chosen in the left rail and lives in the URL, so any screen
can be pasted into a ticket and opens as the sender left it.


```bash
# Import a TestRail instance over the API. Reads credentials from the
# environment; see Configuration.
npm run migrate -- --dry-run
npm run migrate
npm run migrate -- --resume 3          # continue a run that died
npm run migrate -- --project 42        # one TestRail project, for a trial

# Import a TestRail case CSV export. --tz and --date-order have no
# defaults; see the TestRail migration section for why.
npm run migrate:csv -- export.csv --project 1 --tz Asia/Jakarta \
  --date-order mdy --dry-run
```

There is no migration path before the first release. When the schema
version moves, an older database is refused on open, untouched — delete
`data.db*` and create your account again.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `SQLITE_FILE` | `./data.db` | Database path |
| `ATTACHMENTS_DIR` | `./data/attachments` | Where uploaded files are written |
| `MAX_ATTACHMENT_BYTES` | `33554432` | Upload size cap, 32MB |
| `TRUSTED_PROXY_HOPS` | `0` | How many reverse proxies you run in front of the app |
| `TESTRAIL_HOST` | — | e.g. `https://example.testrail.io` |
| `TESTRAIL_USER` | — | TestRail account email |
| `TESTRAIL_API_KEY` | — | API key, not a password |
| `TESTRAIL_RPS` | `5` | Requests per second ceiling for the import |

TestRail credentials go in `.env.local`, never in the repo. The key is
an API key, which TestRail issues per user under *My Settings → API
Keys* — not the account password.

**`TRUSTED_PROXY_HOPS` is a security setting, not a convenience.** Next
passes the caller's `x-forwarded-for` header straight through rather
than appending the socket peer, so with nothing in front of the app that
header is simply what the client typed. At the default of `0` the
per-address login throttle is switched off rather than run against a
value an attacker picks — a spoofable per-IP limit is worse than none,
because it reads as protection while handing out a fresh bucket per
request. Set it to `1` behind one reverse proxy you own, and the entry
that proxy appended is the one used. The per-email throttle always
applies either way.

## Sign-in

Email and password. No self-service signup: accounts come from
`npm run user:add`, or they arrive with the TestRail import.

- scrypt from `node:crypto` (N=16384, r=8, p=1), 16-byte salt per user,
  stored as `scrypt$N$r$p$salt$hash` so the cost can be raised later
  without invalidating existing hashes.
- An unknown email still runs a full verification against a decoy hash,
  so a missing account costs the same wall time as a wrong password.
- One error message for a wrong password, an unknown account and a
  disabled account. No user enumeration.
- Sessions are 256-bit random tokens; only the SHA-256 hash is stored,
  so a database read does not hand over live sessions and revocation is
  a `DELETE`. Cookie is `httpOnly`, `sameSite=lax`, `secure` in
  production.
- 8 failed attempts per email per 15 minutes. Expired sessions and stale
  attempt rows are swept as they are written.

Imported TestRail users land with no password hash and cannot sign in
until an admin sets one; they exist so results attribute correctly. A
deactivated account's API keys stop working the moment the account does.
What is built and what is not is listed in
[`plan/06-auth-and-api.md`](plan/06-auth-and-api.md).

## API

Every route needs a credential, and an anonymous request gets `401` —
swept by a test that walks every route file on disk, so a route added
later is covered the day it lands.

Two credentials reach the API: the session cookie a browser holds, and an
API key a CI job sends as `Authorization: Bearer mtk_...`. They land in
the same shape, so a key reaches exactly the routes its owner reaches and
nothing more.

### Roles

Three, and they are a ladder: a route names the rung it needs.

| Role | Can |
|---|---|
| `tester` | read everything, record results, upload attachments |
| `lead` | all of the above, plus editing the case repository and creating, renaming, closing and reopening runs |
| `admin` | all of the above, plus running an import, defining custom fields, and deleting a run with its results |

A request from too low a rung is a `403` naming the rung it needed. The
check runs before the body is read, so a refusal never depends on the
payload being valid. Screens hide the controls a role cannot use; the
route checks again regardless.

```text
GET  POST          /api/projects              ?search=&page=&limit=
GET  PATCH         /api/projects/[id]
GET  POST          /api/suites                ?projectId=
GET  PATCH         /api/suites/[id]
GET                /api/suites/[id]/sections  the whole tree, one query
     POST          /api/sections
     PATCH         /api/sections/[id]         rename and/or move
GET  POST          /api/cases                 ?suiteId=&sectionId=&typeId=
                                              &priorityId=&search=&page=&limit=
GET  PATCH  DELETE /api/cases/[id]            DELETE is a soft delete
     POST          /api/cases/bulk            move or edit many
GET  POST          /api/case-fields

GET  POST          /api/milestones            ?projectId=
GET  PATCH         /api/milestones/[id]
GET  POST          /api/plans                 ?projectId=
GET  PATCH         /api/plans/[id]
GET  POST          /api/runs                  ?projectId=&planId=
GET  PATCH  DELETE /api/runs/[id]             PATCH closes and reopens
GET                /api/runs/[id]/summary
GET                /api/runs/[id]/tests       ?status=1,5&assignedTo=&page=
     POST          /api/runs/[id]/tests/status   set many at once
     POST          /api/runs/[id]/tests/assign
GET                /api/statuses
     POST          /api/results               one result or a CI run's worth
GET                /api/tests/[id]/results    the change log, newest first
     POST          /api/attachments           multipart/form-data
GET                /api/attachments/[id]

GET                /api/migrate               every import, newest first
GET                /api/migrate/[id]          state, cursor progress, report
     POST          /api/migrate/csv           multipart/form-data
```

### Keys and rate limits

A key is 256 bits of randomness with an `mtk_` prefix, and only its
SHA-256 hash is stored — minting one prints it once and there is no
command that can show it again. Revoking is a timestamp, not a delete, so
a key that ran for six months stays in the audit trail after it stops
working. `last_used_on` is stamped at most once a minute per key, which
is enough to find a dead key and few enough writes to stay off the hot
path.

Key requests are limited to 300 per minute per key; over that is a `429`
with a `Retry-After`. The window lives in the app process, so two
processes get an allowance each — see the note in
[`lib/rate-limit.ts`](lib/rate-limit.ts). A session cookie is never rate
limited: a person cannot loop fast enough to matter, and a CI job can.

### Reporting from CI

One call, one transaction. `caseId` is accepted in place of `testId`,
because a test file knows which case it ran, not which test row that
became inside a run:

```bash
curl -X POST http://localhost:3000/api/results \
  -H "Authorization: Bearer $MINITCMS_KEY" \
  -H "content-type: application/json" \
  -d '{"runId": 12, "results": [
        {"caseId": 1041, "statusId": 1, "elapsed": "4s"},
        {"caseId": 1042, "statusId": 5, "comment": "timeout at step 3"}
      ]}'
```

The run id can also be given per entry. A case that is not in that run is
a `404` naming both ids, never a silently dropped row, and an entry
carrying both a `testId` and a `caseId` is a `400` rather than a guess.
Failed and blocked still need a comment, from CI exactly as from a human.

The three `/api/migrate` routes need the `admin` role. Starting
an API import is deliberately not a route: it is minutes to hours of work
against a live instance, which is a terminal job, not a request a browser
holds open. `npm run migrate` is the interface for it, and
`GET /api/migrate/[id]` is how a screen watches one.

Lists return `{ rows, total, page, limit }`, where `total` is the count
before paging. `limit` snaps to 25, 50 or 100 — an arbitrary value is a
way to ask for the whole table one request at a time.

A body key the route does not recognise is a `400`, not a shrug: a typo
in a field name should not look like a save that worked.

## Running tests

A run is a snapshot. Creating one copies the suite's cases into `tests`
and copies each title with them, so editing or deleting a case later
never rewrites what a past run said it covered.

- Four statuses can be recorded: **passed**, **failed**, **retest**,
  **blocked**. **Untested** is the absence of a result — it is what a
  test is born with, and it can never be written.
- There is no state machine. failed to passed to failed in one
  afternoon is three true facts about three moments, and all three are
  kept.
- Results are append-only. No edit, no delete, no route for either. A
  correction is a new result and the wrong one stays in history.
- Failed and blocked need a comment. Enforced in the database layer, so
  a CI reporter cannot skip it either.
- Closing a run locks it: every result write is refused until somebody
  with the lead or admin role reopens it. Reopening destroys nothing.
- Deleting a run destroys every result in it, so it is admin-only and
  the response says how many were lost.
- A pass rate is always `passed / executed`, never over the whole run,
  and always comes back with its untested count. A run 2% executed and
  100% passing must not read as "100%".

Custom statuses from a TestRail import work everywhere the built-in
five do — the UI reads `/api/statuses` rather than assuming there are
five.

### The run screen, from the keyboard

A run is executed without the mouse. The digits are TestRail's own status
ids, which is why `3` is unbound: untested cannot be recorded.

```text
j / k, up / down   move the row cursor
1 2 4 5            passed / blocked / retest / failed
6 7 8 9            custom statuses, in id order, when the instance has them
space              open the result panel on the cursor row
enter              jump to the next untested test
x                  toggle selection on the cursor row
esc                clear the selection
/                  focus the filter
```

With a selection active a status key applies to the whole selection; with
none, to the cursor row. Failed and blocked open the panel with the comment
focused rather than writing straight through, because the database refuses
either without one - the selection comes with them, and a record against
several tests carries the status and the comment only, since elapsed time,
defects, version and assignee are facts about one test. Passed and retest
write immediately: the row changes on the keystroke and goes back to its old
status, with the reason, if the write is refused. On a closed run the status
keys say so instead of trying.

## Data model

Schema version 11: 18 tables, created in one block and guarded by a
stamp that is read before anything else is applied.

```text
PROJECT holds the truth.
CASE states the intent.
RUN is the attempt.
RESULT is the only history.
MIGRATION must be replayable.
```

- Every table that can receive imported rows carries
  `(source, source_id)` with a unique index. Import is an upsert on that
  pair, which is what makes a migration replayable.
- Results are append-only. A correction is a new result, never an edit.
- A run snapshots the cases it included, so editing a case later never
  rewrites history.
- `projects → suites → sections` cascades on delete, but a deleted case
  leaves its past test rows standing.

## TestRail migration

Two entry points of equal weight: the API v2, and a case CSV export. A
CSV needs no plan tier and no admin willing to issue a key, so it is
what a team can always produce — it is not a degraded mode and it has
its own reader and its own mapper.

Both are **idempotent**: every imported row carries `(source, source_id)`
with a unique index, and import is an upsert on that pair. Running the
same import twice reports zero inserts and zero updates. Both are
**resumable**: the API path checkpoints every step in
`import_runs.cursor`, so `--resume` skips what already landed instead of
re-reading an instance from the start. Nothing is ever deleted to make an
import work.

Both print the same report — counts in, counts out, every unmapped field
and every skipped row — and both fail if the counts do not reconcile.
A migration that cannot account for every row has not succeeded.

**Nothing is guessed.** A field TestRail did not send is `NULL` and shows
up in the report. An unknown priority label does not quietly become
"other"; a result with an unknown status stops the import rather than
defaulting to untested.

### The CSV needs three things the file cannot say

```bash
npm run migrate:csv -- export.csv --project 1 --tz Asia/Jakarta --date-order mdy
```

- `--project` — no column holds it, and it is not inferred from a suite
  name.
- `--tz` — `"10/1/2026 6:26 PM"` carries no offset.
- `--date-order mdy|dmy` — `1/2/2026` is January 2nd or February 1st
  depending on the exporting user's account settings, and nothing in the
  file says which. Without both the import refuses to start.
- `--users "ana=ana@example.com,..."` — optional. A CSV has display
  names where the API has emails, so a name resolves only on a unique
  match; anything else leaves the column `NULL` and reports it.

### Do not run both into one project

`UNIQUE(source, source_id)` is per source, and `testrail` and
`testrail-csv` are different sources — so a CSV import followed by an API
import would land **every case twice**, and the schema cannot see it.
Both importers refuse a project that already holds rows from the other
source and say which, unless `--allow-mixed-sources` is passed. Evaluate
with the CSV, then start the real API import on a fresh project.

### Not built

- **Attachments.** Rows are imported, but their bytes are not fetched —
  that is a second call per row and a disk budget nobody has set. Every
  import says so in its report. A CSV export never had the bytes at all,
  so a non-empty `Attachments` cell is a reported skip.
- **Steps-template CSV exports**, which spread one case over several
  rows. A file with any `Steps (…)` column filled refuses to import
  rather than reading half of it. API imports carry steps fine.
- **TestRail `suite_mode` 2 baselines.** The flag carries over;
  `baseline_of` stays `NULL` and is reported, because `get_suites` does
  not say which suite a baseline came from and nobody has checked this
  against a real mode-2 instance.
- Imported accounts land on the `tester` role. TestRail's role ids are
  instance-specific and its permission model is not ours, so the import
  takes least privilege and reports it; promote whoever needs it.

## License

TBD before the first public release — see
[`plan/07-release.md`](plan/07-release.md).
