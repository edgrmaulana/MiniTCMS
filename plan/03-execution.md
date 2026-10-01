# Phase 3 — Execution

Goal: the half that records what happened. Milestones, plans, runs,
tests, append-only results, attachments.

Depends on phases 1 and 2.

Done when: a run can be created from a filtered case set, results
recorded, and run/plan rollups read in one SQL aggregate each.

## 1. Run creation is a snapshot

`createRun(projectId, suiteId, { includeAll, caseIds, config, planId,
milestoneId })` in one transaction:

1. Insert the `runs` row.
2. Resolve the case set — `includeAll` means "every non-deleted case in
   the suite at this instant", not a live view.
3. `INSERT INTO tests` one row per case, copying `title` into
   `title_snapshot` and setting `status_id = RESULT_STATUS.untested`.

Editing or deleting a case later never touches an existing run. That is
the whole point of the snapshot and it is worth the duplicated title.

## 2. Results are append-only

`addResult(testId, { statusId, comment, elapsed, defects, version,
assignedTo, custom })` in one transaction:

1. `INSERT INTO results`.
2. `UPDATE tests SET status_id = ?` — same transaction, never a separate
   call, or the cache desyncs the first time a request dies midway.

No `updateResult`, no `deleteResult`. A correction is a new result. The
API has no route for either; do not add one "for admins".

`addResultsBulk` for CI reporters: many results, one transaction,
chunked at 500. This is the path a CI run actually uses — it must not be
N round trips.

## 3. Rollups in SQL

- `runSummary(runId)` — one
  `SELECT status_id, COUNT(*) FROM tests WHERE run_id = ? GROUP BY status_id`.
  Never fetch tests and count in JS.
- `planSummary(planId)` — same shape, joined through runs.
- `milestoneSummary(milestoneId)` — rolls up its runs and its child
  milestones (recursive CTE, milestones nest).
- Dashboard numbers come from these three functions and nowhere else.

## 4. Plans and configurations

- A plan groups runs. `plan_entries` is not a separate table in v1 — a
  run with `plan_id` set is an entry. Add the table only if
  configuration groups need it.
- `runs.config` is a text label (TestRail's "Chrome, Windows" string).
  Structured configuration groups are deferred; store the string so the
  import is lossless and revisit if someone filters on it.

## 5. Attachments

- `saveAttachment(entityType, entityId, file)` writes to
  `ATTACHMENTS_DIR` (env, default `./data/attachments`), stores the
  relative path, never the blob, in SQLite.
- One storage function behind one interface so S3 can replace the body
  later. One implementation only — no factory, no driver registry.
- Serve through `GET /api/attachments/[id]`, which authorises then
  streams. Never expose the directory statically.
- Size cap from env, default 32MB. Reject above it with a clear error.

## 6. API routes

```text
GET|POST   /api/milestones        ?projectId=
GET|PATCH  /api/milestones/[id]
GET|POST   /api/plans             ?projectId=
GET|PATCH  /api/plans/[id]
GET|POST   /api/runs              ?projectId=&planId=
GET|PATCH  /api/runs/[id]                 # close / reopen
GET        /api/runs/[id]/tests   ?status=&assignedTo=&page=&limit=
GET        /api/runs/[id]/summary
POST       /api/results                   # one or many
GET        /api/tests/[id]/results
POST       /api/attachments
GET        /api/attachments/[id]
```

## 7. Tests

- Run snapshot: create run, edit the case title, assert
  `title_snapshot` unchanged.
- Result insert updates `tests.status_id` in the same transaction;
  simulate a throw mid-transaction and assert neither row landed.
- `runSummary` with 500 tests across 5 statuses returns correct counts
  and issues one query.
- Attachment path never escapes `ATTACHMENTS_DIR` (traversal in
  filename).

## 8. Checks

`npm run test`, `npm run lint`, `npm run build`.
