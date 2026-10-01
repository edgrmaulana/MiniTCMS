# AGENTS.md

Guidance for AI coding agents working in this repo. Follow it exactly.

This is MiniTCMS: an open-source Test Case Management System built on
Next.js + SQLite, whose first-class job is to **receive a migration from
TestRail**. Projects hold suites, suites hold nested sections, sections
hold cases; runs snapshot cases into tests, tests collect results.
Every entity that came from TestRail keeps its origin
(`source`, `source_id`) so an import can be replayed without duplicating
a single row.

Phased plans live in `plan/` — one file per phase, read the phase you
are working before writing code.

---

## Golden rules

1. **Run checks after every change.** After any file write or edit, run
   `npm run test`, `npm run lint`, and `npm run build` from the repo
   root. Do not end a turn with a failing test or build. If any fails,
   fix your code.
2. **Descriptive variable names — never single characters.** Applies to
   loops, callbacks, destructuring — everywhere. `caseRow`, not `c`.
   `sectionId`, not `sid`.
3. **No hardcoded secrets, no hardcoded hosts.** TestRail credentials
   come from env only (`TESTRAIL_HOST`, `TESTRAIL_USER`,
   `TESTRAIL_API_KEY`). The DB path is env-overridable via
   `SQLITE_FILE`. A credential in a source file, a test, or a fixture
   fails review.
4. **Never invent migrated data.** The TestRail export is the single
   source of truth. A field that TestRail did not send is `NULL` — never
   a guessed default, never a placeholder string. Unmapped custom fields
   are preserved verbatim in the `custom` JSON column and reported, not
   dropped. If something cannot be mapped, fail loud with the source id
   in the error.
5. **Migration is idempotent and resumable.** Every imported row carries
   `(source, source_id)` with a UNIQUE index; import is an upsert keyed
   on that pair. Running the same import twice changes nothing. An
   import that dies halfway resumes from the last committed batch — no
   "delete everything and start over" path.
6. **No duplicate logic.** Before adding a function, scan the codebase
   for an existing one.
   - All SQL lives in `lib/db.ts`. API routes and pages never write raw
     SQL.
   - The TestRail HTTP client lives in `lib/testrail.ts` — one client,
     one auth path, one pagination helper. No `fetch` to TestRail
     anywhere else.
   - TestRail→MiniTCMS field translation lives in `lib/migrate/map.ts`.
     Status ids, priority ids, case types and suite modes are translated
     in exactly one place.
   - Shared formatting and types live in `lib/format.ts`.
7. **Status, priority and type are constants, never literals.** No bare
   `1`, `"passed"`, `5`, or `"failed"` in runtime code. They live as
   named constants in `lib/format.ts` (`RESULT_STATUS`, `CASE_PRIORITY`,
   `CASE_TYPE`, `SUITE_MODE`) and map to TestRail ids in one table.
8. **Write for the human maintainer.** Clear names and an obvious
   top-to-bottom flow over cleverness. Don't over-comment — see below.
9. **No emojis** in code, comments, commit messages, page copy, or CLI
   output. This is a tool people run in CI.
10. **Results are append-only history.** A result is never updated or
    deleted; a new result supersedes the old one. The current status of
    a test is derived from its latest result, never stored twice and
    never edited in place. Run and plan rollups come from SQL
    aggregates, not from JS over fetched rows.
11. **Leave no trash behind.** No scratch files, no sample TestRail
    dumps with real customer data, no temp exports committed.
    `data.db*` (SQLite + WAL files) never ships — it is gitignored.
12. **Review the diff before pushing.** Read every changed line before
    `git push`, and fix review findings first. This repo is public: a
    bad diff is a public bad diff.
13. **Tests for every logic change.** Any new or changed logic in `lib/`
    or `app/api/` ships with a test in the same turn. Migration mapping
    gets a test with a real-shaped TestRail JSON fixture (anonymised).
    UI-only tweaks (copy, classes, layout) need no test. If logic can't
    be tested, say so explicitly and leave a `TODO`.
14. **Every list is paginated, both sides.** TestRail's API pages at 250
    — always follow `_links.next`, never assume one page. Our own lists
    take `(search, limit, page)` and cap rows in SQL with
    `LIMIT ? OFFSET ?` — never fetch-all then slice in JS. A case suite
    can hold 100k cases; code that loads them all fails review.
15. **Open source hygiene.** No internal URLs, no company names, no real
    customer data in fixtures, docs or seeds. Anything a contributor
    needs to run the project is documented in `README.md` in the same
    turn it becomes necessary.

---

## Readability & comments

- **Names carry the meaning.** A well-named variable beats a comment.
- **Don't over-comment.** No comment that restates the code. Code says
  *what*; a comment is only for *why* — a non-obvious reason or a gotcha
  (e.g. why TestRail suite_mode 2 needs a synthetic baseline suite).
- **Straight-line flow.** Prefer a readable top-to-bottom sequence over
  nested cleverness or dense one-liners.
- **No pyramid of doom.** Guard clauses first; keep nesting at most ~3
  levels deep.
- **One obvious way.** Match the surrounding module patterns exactly.
- **No dead code or commented-out blocks.** Delete it; git remembers.

---

## Design principle

```text
PROJECT holds the truth.
CASE states the intent.
RUN is the attempt.
RESULT is the only history.
MIGRATION must be replayable.
```

- A case describes intent — it never stores pass/fail. Execution state
  lives on `tests` and `results`, scoped to a run.
- A run snapshots the cases it included at the moment it was created.
  Editing a case later never rewrites past history.
- `lib/db.ts` owns all data truth; `lib/migrate/*` owns all translation
  truth. Pages and routes consume them and never re-implement.
- Import reports are first-class output: every run of the migration
  prints counts in, counts out, and every skipped or unmapped field.
  Silence is a bug.
- TestRail compatibility is a migration target, not a cage. Where
  TestRail's model is worse, document the deviation in
  `plan/04-testrail-migration.md` and map explicitly.

---

## Project layout

Target shape. Build it as the phases land — do not pre-create empty
files.

```text
.
├── app/
│   ├── page.tsx                  # Dashboard: projects, run health
│   ├── projects/                 # Project list + detail
│   ├── suites/                   # Suite + nested section tree
│   ├── cases/                    # Case list, case detail, steps editor
│   ├── runs/                     # Run list, run detail, result entry
│   ├── migrate/                  # TestRail import wizard + report
│   └── api/
│       ├── projects/…            # REST over lib/db.ts
│       ├── cases/…
│       ├── runs/…
│       ├── results/…
│       └── migrate/…             # Start / status / report
├── lib/
│   ├── db.ts                     # SQLite: schema, indexes, all queries
│   ├── db.test.ts                # Tests for db logic (fresh DB per test)
│   ├── format.ts                 # Shared types + status/priority constants
│   ├── testrail.ts               # TestRail API v2 client (auth, paging)
│   └── migrate/
│       ├── map.ts                # TestRail → MiniTCMS field translation
│       ├── map.test.ts           # Fixture-driven mapping tests
│       └── run.ts                # Ordered, resumable import pipeline
├── plan/                         # Phased implementation plans
├── data.db*                      # Local SQLite (gitignored)
└── package.json                  # Next.js 16, React 19, better-sqlite3, vitest
```

- Server owns data: client pages fetch `/api/*`, never import
  `lib/db.ts`. `lib/format.ts` is shared client+server.
- Thin routes: API handlers validate input and delegate to `lib/db.ts`
  — no SQL strings outside `db.ts`.
- One file per concern. No second query file, no second client.

---

## Data rules

- Every table that can receive imported rows has:
  `source TEXT`, `source_id INTEGER`, with
  `UNIQUE(source, source_id)`. `source` is `'testrail'` for imported
  rows, `NULL` for native ones.
- Sections nest via `parent_id` with a `depth` column; tree reads use a
  recursive CTE in `lib/db.ts`, never N+1 queries from the route.
- Add the index in the same `db.exec` block, same turn, whenever a new
  query gets a `WHERE` / `ORDER BY` / `JOIN` on a fresh column.
- Custom fields live in a `custom` JSON column plus a `case_fields`
  definition table. Never add a migration-specific physical column for
  one customer's field.
- `data.db`, `data.db-wal`, `data.db-shm` stay local — override the path
  with `SQLITE_FILE` for tests.

---

## Running

```bash
# Install dependencies
npm install

# Development server
npm run dev

# Tests + lint + production build (run all three after every change)
npm run test
npm run lint
npm run build

# Fresh local database
rm -f data.db*
```

TestRail import needs these in `.env.local` (never committed):

```bash
TESTRAIL_HOST=https://example.testrail.io
TESTRAIL_USER=you@example.com
TESTRAIL_API_KEY=...
```

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
