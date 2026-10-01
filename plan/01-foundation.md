# Phase 1 — Foundation

Goal: one SQLite module that owns the whole schema, one constants module
that owns every status/priority/type id, and a test harness that gives
each test a fresh database. Nothing user-facing ships here.

**Status: done.** Schema version 6: 17 tables, 34 indexes, the five
built-in statuses seeded. `lib/format.ts` owns the constants. 72 tests
pass.

- v5 added `cases.updated_by` — both TestRail entry points carry an
  updating user and there was nowhere to put it.
- v6 widened two indexes on `cases` after measuring phase 2's queries
  against 100k rows. No columns changed.

| Section | State |
|---------|-------|
| 1 Database bootstrap | done |
| 2 Schema | done |
| 3 Indexes | done |
| 4 Constants | done |
| 5 Test harness | done |

Phase 2 is unblocked.

Done when: `npm run test` runs real tests against a temp DB, and
`npm run build` passes with `lib/db.ts` imported by one smoke route.

## 1. Database bootstrap — `lib/db.ts`

- `better-sqlite3`, path from `SQLITE_FILE` env, default `./data.db`.
- `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`. Both on every
  connection — foreign keys are off by default in SQLite and silently
  so.
- `schema_version` is created and read **before** any other DDL runs, so a
  database from another build is refused without being touched. Creating
  its missing tables first and complaining afterwards is exactly the
  half-working this guard exists to prevent.
- A failed open closes the handle. `getDb` does not cache a failure, so
  without that every request against a stale file would leak another
  handle and its WAL lock.
- The auth tables shipped first, at version 2, because the login page
  needed them. Version 3 adds the rest. A mismatched stamp throws on
  open, so an old `data.db` fails loud instead of half-working. Until
  the first release there is no migration path: bump the stamp and
  `rm -f data.db*`.
- Module-level singleton connection. Next.js dev reloads: stash it on
  `globalThis` so hot reload does not open a new handle per edit.

## 2. Schema v6

All tables created up front even though phases 2 and 3 fill them — one
`db.exec`, one review.

```text
projects        id, name, announcement, suite_mode, is_completed,
                created_on, source, source_id
suites          id, project_id, name, description, is_baseline,
                baseline_of, source, source_id
sections        id, suite_id, parent_id, depth, display_order, name,
                description, source, source_id
cases           id, section_id, suite_id, title, template_id, type_id,
                priority_id, refs, estimate, milestone_id, custom JSON,
                is_deleted, created_by, created_on, updated_by,
                updated_on, source, source_id
case_fields     id, system_name, label, type, is_global, configs JSON,
                source, source_id
milestones      id, project_id, parent_id, name, description, due_on,
                started_on, is_completed, source, source_id
plans           id, project_id, name, description, milestone_id,
                is_completed, created_on, source, source_id
runs            id, project_id, suite_id, plan_id, milestone_id, name,
                description, config, include_all, is_completed,
                created_on, source, source_id
tests           id, run_id, case_id, title_snapshot, status_id,
                assigned_to, source, source_id
results         id, test_id, status_id, comment, version, elapsed,
                defects, assigned_to, custom JSON, created_by,
                created_on, source, source_id
attachments     id, entity_type, entity_id, filename, mime, size,
                storage_path, source, source_id
users           DONE: id, email, name, role, is_active, password_hash,
                created_on, source, source_id
sessions        DONE: token_hash, user_id, created_on, expires_on, user_agent
login_attempts  DONE: id, identifier, attempted_on
statuses        id, system_name, label, color, is_untested, is_final
import_runs     id, source, started_on, finished_on, state, cursor JSON,
                report JSON
```

- Every importable table ends with `source TEXT, source_id INTEGER` and
  `UNIQUE(source, source_id)`. This is what makes phase 4 replayable —
  it is cheaper now than as a migration later. SQLite treats NULLs as
  distinct in a unique index, so native rows (both columns NULL) never
  collide with each other, and `'testrail'` and `'testrail-csv'` can
  carry the same id without a clash. Both are tested.
- Delete behaviour is chosen per edge, not copied:
  `projects → suites → sections` cascades, `cases.section_id` and
  `tests.case_id` are `SET NULL`. Deleting a case must never delete the
  record that it once ran — `title_snapshot` is why the test survives.
- `results.status_id` and `tests.status_id` are real foreign keys onto
  `statuses`, so a result can never reference a status that does not
  exist. The five built-ins are seeded on open at TestRail's ids.
- `CHECK` constraints on `role`, `suite_mode`, section `depth` and
  attachment `entity_type`, every one interpolated from the matching
  constant in `lib/format.ts` at module load. The phase 4 import writes
  these columns from somebody else's data; an application-layer check
  alone would not hold, and a hand-written value list drifts from its
  constant in silence.
- `cases`, `tests` and `results` use `AUTOINCREMENT`. SQLite otherwise
  reuses `max(rowid) + 1`, and because `attachments` is polymorphic with
  no foreign key, a new case landing on a deleted case's id would
  silently inherit its files.
- `tests.status_id` is a denormalised cache of the latest result. It is
  written only by the same transaction that inserts a result (phase 3),
  never by hand.

## 3. Indexes, same block

```sql
CREATE INDEX idx_suites_project    ON suites(project_id);
CREATE INDEX idx_sections_suite    ON sections(suite_id);
CREATE INDEX idx_sections_parent   ON sections(parent_id);
CREATE INDEX idx_cases_section     ON cases(section_id, is_deleted);
CREATE INDEX idx_cases_suite       ON cases(suite_id, is_deleted, section_id, id);
CREATE INDEX idx_cases_title       ON cases(title);
CREATE INDEX idx_runs_project      ON runs(project_id);
CREATE INDEX idx_runs_plan         ON runs(plan_id);
CREATE INDEX idx_tests_run         ON tests(run_id);
CREATE INDEX idx_tests_case        ON tests(case_id);
CREATE INDEX idx_results_test      ON results(test_id, created_on DESC);
CREATE INDEX idx_attach_entity     ON attachments(entity_type, entity_id);
```

`idx_results_test` is the one that matters: "latest result per test" is
the hottest read in the product.

The two on `cases` are wider than they look like they need to be, and
both were measured at 100k rows rather than guessed:

- `idx_cases_suite` carries `section_id, id` so it covers `listCases`
  down to its `ORDER BY`. One column narrower, every page answered with
  `USE TEMP B-TREE FOR ORDER BY` — sorting all 100k matching rows to
  return 25. Page 1 went 116ms to 0.2ms, page 1000 40ms to 0.6ms.
- `idx_cases_section` carries `is_deleted` so `sectionTree`'s count per
  section is a covering index scan. The tree over 200 sections went
  207ms to 1.6ms.

A paged list needs an index for its `ORDER BY` as well as its `WHERE`,
and the second one is the one that gets forgotten.

## 4. Constants — `lib/format.ts`

Shared client+server. No DB import.

- `RESULT_STATUS`: passed 1, blocked 2, untested 3, retest 4, failed 5.
  TestRail's built-in ids, kept deliberately so phase 4 maps 1:1. Custom
  statuses start at 6, same as TestRail.
- `SUITE_MODE` (1 single, 2 single+baselines, 3 multi) and
  `CASE_TEMPLATE` (1 text, 2 steps, 3 exploratory) are TestRail's fixed
  values and map straight across.
- `CASE_PRIORITY` and `CASE_TYPE` are **ours, not TestRail's**. A
  TestRail admin can add, rename and reorder both, so assuming the ids
  line up would be inventing data. The import reads `get_priorities`
  and `get_case_types` and translates in `lib/migrate/map.ts`.
- `PAGE_SIZES = [25, 50, 100]`, `clampPageSize`, `clampPage`,
  `offsetFor`. Every list query in every later phase uses these — no
  second pager. `clampPage` has a `MAX_PAGE` ceiling: unbounded, an
  absurd `?page=` multiplies into an offset SQLite cannot bind, and the
  route 500s instead of returning an empty page. `offsetFor` clamps both
  of its arguments itself rather than trusting the caller to have done
  it.
- `MAX_SECTION_LEVELS`, named for levels rather than for a maximum depth
  because `depth` is 0-indexed. `depth <= MAX_SECTION_DEPTH` is the
  guard a reader writes by reflex, and it is off by one against the
  CHECK — hence the name.
- `ATTACHMENT_ENTITIES`, interpolated into the `entity_type` CHECK.
- Shared TS types for every row above. Rows are plain objects; no
  classes.

## 5. Test harness

- `vitest`, `npm run test` already wired.
- Each test sets `SQLITE_FILE` to a unique temp path, imports a fresh
  `openDb(path)`, and deletes the file after. No shared fixture DB — a
  leaked row between tests is a bug that takes an hour to find.
- `lib/db.test.ts` is the only db test file. First tests: schema
  applies, foreign keys actually enforce, `UNIQUE(source, source_id)`
  actually rejects a duplicate import.

## 6. Checks

`npm run test`, `npm run lint`, `npm run build` all green before phase 2.
