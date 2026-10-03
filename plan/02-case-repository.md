# Phase 2 — Case repository

Goal: the half of the product that stores intent. Projects, suites,
nested sections, cases, custom field definitions. Query layer plus thin
API routes. No execution, no UI beyond what a test can call.

Depends on phase 1. Blocks phases 3, 4 and 5.

**Status: done.** Every query, all eleven routes and 21 new tests. 72
tests pass. Schema v6 widened two indexes on `cases` after measuring
the queries this phase added.

| Section | State |
|---------|-------|
| 1 Queries | done |
| 2 Case content | done — `custom.steps` is a convention, not a column |
| 3 Custom fields | done, minus per-project scoping |
| 4 API routes | done — all eleven, behind a session |
| 5 Tests | done |

Deferred, deliberately, and neither blocks phase 3:

- **Per-project field scoping** (`configs.context`). Every field is
  global for now. Nothing has asked for the other case yet, and the
  shape it should take depends on what the TestRail import actually
  sends in `configs`.
- **Role checks on writes.** Every route requires a session; none
  requires a particular role. Who may create a project rather than a
  case is a phase 6 question, answered once, for every route at the
  same time.
- **Cross-project scope on `milestone_id`.** A case's milestone is
  checked for existence by the foreign key and nothing more, so a case
  can point at a milestone in another project. `section_id` is checked
  against the suite, because that one is reachable today; milestones
  arrive in phase 3 and the check belongs in the same turn as the
  screen that can set one.

Done when: a 10k-case tree can be created, searched, moved and paged
through the API without a single unbounded query.

## 1. Queries — all in `lib/db.ts`

Every list takes `(search, limit, page)` and ends in
`LIMIT ? OFFSET ?`. Every list returns `{ rows, total }`; `total` is a
separate `COUNT(*)` with the same `WHERE`, not `rows.length`.

- `listProjects`, `getProject`, `createProject`, `updateProject`.
- `listSuites(projectId, …)`, suite CRUD.
- `sectionTree(suiteId)` — one recursive CTE returning
  `(id, parent_id, depth, display_order, name, description,
  case_count)` in render order. The CTE builds a `sort_path` as it
  walks, so the rows come back depth-first with siblings in
  `display_order` and the caller indents by `depth` without sorting
  again. One query for the whole tree, never a fetch per level. Cap
  depth at 6 like TestRail does; reject deeper on insert with a loud
  error. The recursion carries a level bound as well: a `parent_id`
  cycle would otherwise spin the CTE until the process dies.
- `moveSection(sectionId, newParentId, newOrder)` — rewrites `depth` for
  the moved subtree in one `UPDATE … WHERE id IN (recursive CTE)`.
  Reject a move into own descendant.
- `listCases(suiteId, { search, sectionId, typeId, priorityId, limit,
  page })` — `search` hits `title` and `refs`, parameterised `LIKE`.
- `getCase`, `createCase`, `updateCase`, `deleteCase` (soft: set
  `is_deleted`, keep history intact — a hard delete orphans results).
  `createCase` writes all four authorship columns, `updateCase` writes
  `updated_by` and `updated_on` on every call — never only the
  timestamp. Both are nullable because an import may not know who.
- `bulkMoveCases(caseIds, sectionId)` and `bulkUpdateCases` — one
  statement with an `IN` list, chunked at 500 ids. Phase 4 imports lean
  on these.

## 2. Case content

- Steps: `custom.steps` as a JSON array of
  `{ content, expected, refs }`. Matches TestRail's
  `custom_steps_separated` shape exactly so phase 4 is a copy, not a
  transform. Plain-text templates keep `custom.steps_text`.
- `template_id` decides which fields the UI shows. Templates seeded:
  1 Text, 2 Steps, 3 Exploratory. No BDD template: Gherkin is text in a
  text field, typed by the author or carried over verbatim by the
  import, and never parsed.
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
- Definitions are keyed on `system_name` and upserted, so a CSV import
  that can only infer `type: 'text'` (phase 4, 6.4) is corrected in
  place by a later API import rather than duplicated.
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
