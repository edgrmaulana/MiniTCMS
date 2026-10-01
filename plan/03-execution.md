# Phase 3 — Execution

Goal: the half that records what happened. Milestones, plans, runs,
tests, append-only results, attachments. The product this phase ships
is the thing a tester does all day: open a run, walk the list, mark
each case **passed**, **failed**, **retest** or **blocked**.

Depends on phases 1 and 2.

**Status: not started.** Nothing from this phase exists. The tables do:
`runs`, `tests`, `results`, `statuses`, `plans`, `milestones`,
`attachments` all landed in phase 1, with the five built-in statuses
seeded at TestRail's ids and `tests.status_id` defaulting to untested.

Done when: a run can be created from a filtered case set, every test in
it can be set to any assignable status with one keystroke, the status
survives a reload, and run/plan rollups read in one SQL aggregate each.

## 1. Run creation is a snapshot

`createRun(projectId, suiteId, { name, includeAll, caseIds, config,
planId, milestoneId, assignedTo })` in one transaction:

1. Insert the `runs` row.
2. Resolve the case set — `includeAll` means "every non-deleted case in
   the suite at this instant", not a live view. Otherwise `caseIds`,
   which is what the Cases screen hands over after a filter.
3. `INSERT INTO tests` one row per case, copying `title` into
   `title_snapshot` and leaving `status_id` at its untested default.

Editing or deleting a case later never touches an existing run. That is
the whole point of the snapshot and it is worth the duplicated title.

A run created from a filter stores no filter. The case set is resolved
once, at creation. "Re-run the same filter" creates a second run; it
never mutates the first.

## 2. The status set

Five built-ins, seeded in phase 1 at TestRail's ids:

| id | system_name | assignable | is_final | meaning |
|----|-------------|-----------|----------|---------|
| 1 | passed | yes | yes | ran, behaved |
| 2 | blocked | yes | yes | could not run — environment, dependency, missing data |
| 3 | untested | **no** | no | no result exists yet |
| 4 | retest | yes | no | ran, needs another look — usually after a fix |
| 5 | failed | yes | yes | ran, did not behave |

Rules that fall out of that table, each of which has to be written
down or someone will implement the opposite:

- **Untested is not a result, it is the absence of one.** It is the
  default on `tests.status_id` at run creation and it is never inserted
  into `results`. `addResult` rejects `RESULT_STATUS.untested` loud.
  There is no "un-pass this test" — a mistake is corrected by recording
  the right status, and the wrong one stays in history.
- **No state machine.** Any assignable status to any assignable status,
  any number of times. TestRail has no transition rules and neither do
  we; a case can go failed → passed → failed in one afternoon and all
  three are true facts about three moments.
- **The assignable set is read from the `statuses` table, never
  hardcoded to four.** A TestRail import brings custom statuses at id
  >= 6 and they are first-class: they appear in the entry UI, in the
  filters and in the rollups. `lib/format.ts` grows
  `isAssignableStatus(statusRow)` — `is_untested = 0` — and the UI asks
  the database, not the constant.
- `is_final` separates "this test is done" from "this test still wants
  something". Retest and untested are not final. This is what the
  "needs attention" filter and the pass-rate denominator are built on,
  not a hardcoded `IN (1, 5)`.

**Pass rate is defined once**, in `lib/format.ts`, and every screen uses
that one definition: `passed / (tests with a final status)`. Untested
and retest are excluded from the denominator, and the count of them is
always shown next to the percentage. A run that is 2% executed and 100%
passing must never render as "100%" with no context — that is the
single most common way a test report lies.

## 3. Recording a result

`addResult(testId, { statusId, comment, elapsed, defects, version,
assignedTo, custom, createdBy })` in one transaction:

1. Reject if the status is not assignable, or the run is closed (§4).
2. `INSERT INTO results`.
3. `UPDATE tests SET status_id = ?` — same transaction, never a
   separate call, or the cache desyncs the first time a request dies
   midway.

No `updateResult`, no `deleteResult`. A correction is a new result. The
API has no route for either; do not add one "for admins".

`setStatusBulk(testIds, statusId, { comment, createdBy })` — the "select
40 rows, mark them all blocked" path. One result row per test plus one
`UPDATE … WHERE id IN (…)`, one transaction, chunked at 500 ids. It is
the same write as `addResult`, batched, not a second code path.

`addResultsBulk(entries)` for CI reporters: many tests, many statuses,
one transaction, chunked at 500. This is the path a CI run actually
uses — it must not be N round trips.

- `comment` is required when the status is failed or blocked, and
  optional otherwise. A failure with no note is a failure somebody has
  to reproduce from scratch tomorrow. Enforced in `lib/db.ts` so the CI
  reporter path cannot skip it.
- `elapsed` stores TestRail's string verbatim (`"1m 45s"`) — it is TEXT
  for exactly that reason. Parsing to seconds for a sum is a display
  concern and lives in `lib/format.ts`. Never rewrite it on the way in.
- `defects` is a free comma-separated string, same as `refs`. No
  tracker integration in scope.
- A test's history is its results, newest first, straight off
  `idx_results_test`. That is the change log; there is no separate audit
  table.

## 4. Run lifecycle

`runs.is_completed` is a lock, not a label.

- **Open** (`0`): results accepted.
- **Closed** (`1`): `addResult`, `setStatusBulk` and `addResultsBulk`
  all reject with an error naming the run. Enforced in `lib/db.ts`, not
  in the route, so a CI reporter posting to a closed run gets the same
  answer as the UI.
- **Reopen** sets it back to `0`. Allowed, and it destroys nothing — the
  results were never deleted. Restricted to `lead` and `admin`.
- Closing recomputes nothing. The rollup was already correct.

Deleting a run cascades its tests and its results, and that is the one
genuinely destructive path in the product. Admin only, and the UI
confirms with the result count in the prompt. Closing is what people
actually want nine times out of ten; the UI offers it first.

## 5. Assignment

`assignTests(testIds, userId | null)` — chunked at 500, same shape as
the bulk status write. `tests.assigned_to` already exists; a run can
also be created with a default assignee for every test.

**Assignment is a work queue, not a lock.** Anyone may record a result
on any test in an open run. Do not add an ownership check — in a real
team the person free at 5pm finishes someone else's run, and a tool
that blocks that gets worked around within a week.

`results.assigned_to` is separate and is TestRail's "reassign on
result": recording a result can hand the test to someone else, which is
how a failed test reaches the person who will retest it.

## 6. Rollups in SQL

- `runSummary(runId)` — one
  `SELECT status_id, COUNT(*) FROM tests WHERE run_id = ? GROUP BY status_id`.
  Never fetch tests and count in JS. Returns a row per status present,
  including the custom ones, which is why the UI cannot assume five.
- `planSummary(planId)` — same shape, joined through runs.
- `milestoneSummary(milestoneId)` — rolls up its runs and its child
  milestones (recursive CTE, milestones nest).
- Dashboard numbers come from these three functions and nowhere else.

## 7. Plans and configurations

- A plan groups runs. `plan_entries` is not a separate table in v1 — a
  run with `plan_id` set is an entry. Add the table only if
  configuration groups need it.
- `runs.config` is a text label (TestRail's "Chrome, Windows" string).
  Structured configuration groups are deferred; store the string so the
  import is lossless and revisit if someone filters on it.

## 8. Attachments

- `saveAttachment(entityType, entityId, file)` writes to
  `ATTACHMENTS_DIR` (env, default `./data/attachments`), stores the
  relative path, never the blob, in SQLite.
- One storage function behind one interface so S3 can replace the body
  later. One implementation only — no factory, no driver registry.
- Serve through `GET /api/attachments/[id]`, which authorises then
  streams. Never expose the directory statically.
- Size cap from env, default 32MB. Reject above it with a clear error.
- A screenshot attached while recording a failure is the common case:
  the attachment is written first, then referenced by the result in the
  same request. A failed upload must not leave a result without its
  evidence, so the result insert happens last.

## 9. API routes

```text
GET|POST   /api/milestones        ?projectId=
GET|PATCH  /api/milestones/[id]
GET|POST   /api/plans             ?projectId=
GET|PATCH  /api/plans/[id]
GET|POST   /api/runs              ?projectId=&planId=
GET|PATCH  /api/runs/[id]                 # close / reopen
DELETE     /api/runs/[id]                 # admin, cascades
GET        /api/runs/[id]/tests   ?status=&assignedTo=&page=&limit=
GET        /api/runs/[id]/summary
POST       /api/runs/[id]/tests/status    # bulk set status
POST       /api/runs/[id]/tests/assign    # bulk assign
GET        /api/statuses                  # built-in + imported custom
POST       /api/results                   # one or many
GET        /api/tests/[id]/results
POST       /api/attachments
GET        /api/attachments/[id]
```

`?status=` takes a comma-separated id list so "show me everything not
passed" is one request. Paged like every other list, through
`clampPageSize`.

## 10. Tests

- Run snapshot: create run, edit the case title, assert
  `title_snapshot` unchanged.
- New tests start untested and have zero result rows.
- `addResult` with `untested` throws.
- `addResult` with failed and no comment throws; with passed and no
  comment succeeds.
- Result insert updates `tests.status_id` in the same transaction;
  simulate a throw mid-transaction and assert neither row landed.
- Three results on one test: `tests.status_id` is the newest, all three
  rows survive, history reads newest-first.
- A closed run rejects a result, and rejects a bulk set, naming the run.
  Reopening it accepts one again.
- `setStatusBulk` over 600 ids writes 600 results and 600 updated tests
  in one transaction.
- A custom status at id 6 is assignable and lands in `runSummary`.
- `runSummary` with 500 tests across 5 statuses returns correct counts
  and issues one query.
- Pass rate with 10 passed, 2 failed, 88 untested is 83%, not 10%.
- Attachment path never escapes `ATTACHMENTS_DIR` (traversal in
  filename).

## 11. Checks

`npm run test`, `npm run lint`, `npm run build`.
