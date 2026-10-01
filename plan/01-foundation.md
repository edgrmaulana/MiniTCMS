# Phase 1 — Foundation

Goal: one SQLite module that owns the whole schema, one constants module
that owns every status/priority/type id, and a test harness that gives
each test a fresh database. Nothing user-facing ships here.

Done when: `npm run test` runs real tests against a temp DB, and
`npm run build` passes with `lib/db.ts` imported by one smoke route.

## 1. Database bootstrap — `lib/db.ts`

- `better-sqlite3`, path from `SQLITE_FILE` env, default `./data.db`.
- `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`. Both on every
  connection — foreign keys are off by default in SQLite and silently
  so.
- Single `db.exec(SCHEMA)` block on first open, guarded by a
  `schema_version` table. Version 1 is this phase.
- Module-level singleton connection. Next.js dev reloads: stash it on
  `globalThis` so hot reload does not open a new handle per edit.

## 2. Schema v1

Tables created now even if phases 2 and 3 fill them — one `db.exec`,
one review.

```text
projects        id, name, announcement, suite_mode, is_completed,
                created_on, source, source_id
suites          id, project_id, name, description, is_baseline,
                baseline_of, source, source_id
sections        id, suite_id, parent_id, depth, display_order, name,
                description, source, source_id
cases           id, section_id, suite_id, title, template_id, type_id,
                priority_id, refs, estimate, milestone_id, custom JSON,
                created_by, created_on, updated_on, source, source_id
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
users           id, email, name, role, is_active, password_hash,
                source, source_id
statuses        id, system_name, label, color, is_untested, is_final
import_runs     id, source, started_on, finished_on, state, cursor JSON,
                report JSON
```

- Every importable table ends with `source TEXT, source_id INTEGER` and
  `UNIQUE(source, source_id)`. This is what makes phase 4 replayable —
  it is cheaper now than as a migration later.
- `tests.status_id` is a denormalised cache of the latest result. It is
  written only by the same transaction that inserts a result (phase 3),
  never by hand.

## 3. Indexes, same block

```sql
CREATE INDEX idx_suites_project    ON suites(project_id);
CREATE INDEX idx_sections_suite    ON sections(suite_id);
CREATE INDEX idx_sections_parent   ON sections(parent_id);
CREATE INDEX idx_cases_section     ON cases(section_id);
CREATE INDEX idx_cases_suite       ON cases(suite_id);
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

## 4. Constants — `lib/format.ts`

Shared client+server. No DB import.

- `RESULT_STATUS`: passed 1, blocked 2, untested 3, retest 4, failed 5.
  TestRail's built-in ids, kept deliberately so phase 4 maps 1:1. Custom
  statuses start at 6, same as TestRail.
- `CASE_PRIORITY`, `CASE_TYPE`, `SUITE_MODE` (1 single, 2 single+baselines,
  3 multi).
- `PAGE_SIZES = [25, 50, 100]`, `clampPageSize`, `clampPage`. Every list
  query in every later phase uses these — no second pager.
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
