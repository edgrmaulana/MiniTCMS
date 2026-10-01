# Phase 2 — Case repository

Goal: the half of the product that stores intent. Projects, suites,
nested sections, cases, custom field definitions. Query layer plus thin
API routes. No execution, no UI beyond what a test can call.

Depends on phase 1. Blocks phases 3, 4 and 5.

**Status: not started.** No table, query, route or test from this phase
exists. Needs the phase 1 schema first.

Done when: a 10k-case tree can be created, searched, moved and paged
through the API without a single unbounded query.

## 1. Queries — all in `lib/db.ts`

Every list takes `(search, limit, page)` and ends in
`LIMIT ? OFFSET ?`. Every list returns `{ rows, total }`; `total` is a
separate `COUNT(*)` with the same `WHERE`, not `rows.length`.

- `listProjects`, `getProject`, `createProject`, `updateProject`.
- `listSuites(projectId, …)`, suite CRUD.
- `sectionTree(suiteId)` — one recursive CTE returning
  `(id, parent_id, depth, name, case_count)` ordered by
  `(parent_id, display_order)`. One query for the whole tree, never a
  fetch per level. Cap depth at 6 like TestRail does; reject deeper on
  insert with a loud error.
- `moveSection(sectionId, newParentId, newOrder)` — rewrites `depth` for
  the moved subtree in one `UPDATE … WHERE id IN (recursive CTE)`.
  Reject a move into own descendant.
- `listCases(suiteId, { search, sectionId, typeId, priorityId, limit,
  page })` — `search` hits `title` and `refs`, parameterised `LIKE`.
- `getCase`, `createCase`, `updateCase`, `deleteCase` (soft: set
  `is_deleted`, keep history intact — a hard delete orphans results).
- `bulkMoveCases(caseIds, sectionId)` and `bulkUpdateCases` — one
  statement with an `IN` list, chunked at 500 ids. Phase 4 imports lean
  on these.

## 2. Case content

- Steps: `custom.steps` as a JSON array of
  `{ content, expected, refs }`. Matches TestRail's
  `custom_steps_separated` shape exactly so phase 4 is a copy, not a
  transform. Plain-text templates keep `custom.steps_text`.
- `template_id` decides which fields the UI shows. Templates seeded:
  1 Text, 2 Steps, 3 Exploratory. BDD deferred — see `README.md` open
  questions.
- `refs` is a free string, comma-separated. No issue-tracker integration
  in scope; a ref is a link the UI may linkify and nothing more.

## 3. Custom fields

- `case_fields` rows define the schema; `cases.custom` holds values.
  Nothing is added as a physical column, ever — a TestRail instance with
  60 custom fields must not become 60 `ALTER TABLE`s.
- Field types supported: string, text, integer, dropdown, multiselect,
  checkbox, date, user, steps. Anything else imports as raw JSON with a
  warning in the report.
- Validation on write: value must match the declared type. A dropdown
  value not in `configs` is rejected loud, not coerced.
- `is_global` or per-project scoping via `configs.context`, same shape
  as TestRail.

## 4. API routes — `app/api/`

Thin. Validate, delegate, return. No SQL.

```text
GET|POST   /api/projects
GET|PATCH  /api/projects/[id]
GET|POST   /api/suites            ?projectId=
GET|PATCH  /api/suites/[id]
GET        /api/suites/[id]/sections      # the tree, one call
POST       /api/sections
PATCH      /api/sections/[id]             # rename, move
GET|POST   /api/cases             ?suiteId=&sectionId=&search=&page=&limit=
GET|PATCH|DELETE /api/cases/[id]
POST       /api/cases/bulk                # move / update many
GET|POST   /api/case-fields
```

Input validation at the boundary: ids are integers, `limit` through
`clampPageSize`, unknown body keys rejected rather than ignored.

## 5. Tests

Extend `lib/db.test.ts`:

- Section tree: build 4 levels, assert one query returns correct depths
  and ordering.
- Move rejects a cycle, and rewrites descendant depth.
- `listCases` with 1000 seeded cases: page 2 of 25 returns the right
  slice and `total` is 1000.
- Custom field validation: bad dropdown value throws; unknown type round
  trips as raw JSON.
- Soft delete: deleted case stays joinable from `tests`.

## 6. Checks

`npm run test`, `npm run lint`, `npm run build`.
