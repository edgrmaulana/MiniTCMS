# MiniTCMS plan

Open-source Test Case Management System on Next.js + SQLite. The reason
it exists: teams on TestRail want out, and the exit path is the product.
Migration is phase 4, but every earlier phase is shaped by it — read
`04-testrail-migration.md` before designing any table.

Rules of engagement live in `../AGENTS.md`. This folder is the *what*
and *when*; AGENTS.md is the *how*.

## Phases

| # | File | Ships | Status |
|---|------|-------|--------|
| 1 | `01-foundation.md` | SQLite layer, schema, constants, test harness | done |
| 2 | `02-case-repository.md` | Projects, suites, nested sections, cases, custom fields | done |
| 3 | `03-execution.md` | Runs, test execution, pass/fail/retest/blocked, rollups | done |
| 4 | `04-testrail-migration.md` | TestRail client, CSV reader, field mapping, resumable import | done, bar attachments |
| 5 | `05-ui.md` | App shell and the five screens that make it usable | done |
| 6 | `06-auth-and-api.md` | Login, roles, public REST API, CI reporters | done - accounts are CLI-only, no users screen |
| 7 | `07-release.md` | Docker, CI, license, contributor docs, v0.1.0 | done, bar the tag |

Each phase file opens with its own status and a per-section breakdown.
Update them in the same turn the work lands, or this table starts
lying.

Phases 1→4 are strictly ordered. Phase 5 can start once phase 2 lands.
Phase 7 is last.

Phase 6 jumped the queue: the login page was built first, which pulled
the `users`, `sessions` and `login_attempts` slice of the phase 1 schema
forward with it. Phase 1 has since landed the rest, phase 6 added
`api_keys`, and phase 4's section-depth fix took it to version 12.

## Scope

In: case management (projects, suites, sections, cases, custom fields),
execution (runs, plans, milestones, results, attachments), a TestRail
import that is lossless or loud, a REST API good enough for CI
reporters, self-hostable in one container.

Out, deliberately, until someone asks: requirements/defect tracker
integrations beyond a `refs` string, SSO/SAML, real-time collaboration,
a plugin system, multi-tenancy, anything billed. Single-org self-host is
the whole target.

## Decisions already made

- **SQLite via better-sqlite3**, file-backed, `SQLITE_FILE` override.
  Self-hosters get one file to back up. Revisit only if a real user hits
  write contention.
- **TestRail ids are kept, not reused.** Every imported row stores
  `(source, source_id)`; MiniTCMS ids are its own. Old TestRail links
  resolve via lookup, never by pretending the ids are the same.
- **CSV import is first-class, not a fallback.** API access to TestRail
  needs a plan tier and an admin; a case export needs neither, and it
  is what the first real sample of this project's input turned out to
  be. The API path and the CSV path ship together in phase 4, with
  separate readers and separate mappers — the CSV carries labels where
  the API carries ids, so sharing one mapper would mean guessing.
- **Results append-only.** No update, no delete. Current status is the
  latest result.
- **Untested is the absence of a result, not a result.** The four
  assignable built-ins are passed, failed, retest and blocked; untested
  is the default a test is born with and is never written to `results`.
  A pass rate therefore always ships next to its untested count — see
  `03-execution.md` section 2.
- **No ORM.** Hand-written SQL in `lib/db.ts`. The schema is ~15 tables
  and it is not going to surprise anyone.
- **Sessions in the database, not a JWT.** Only the token hash is
  stored, so revocation is a `DELETE` and a leaked database dump does
  not hand over live logins. Details in `06-auth-and-api.md`.
- **Roles are a ladder, not a set.** tester < lead < admin, ranked in
  `lib/format.ts`, and a route names the rung it needs. A list of
  acceptable roles is what somebody forgets to extend, and forgetting it
  fails open.
- **API keys are credentials, not identities.** A key's role is read off
  its owner's row on every request, so it can never outlive or outrank
  the account that made it.
- **MIT, held by "MiniTCMS contributors."** Decided in phase 7, before
  the first public release, because relicensing later needs every
  contributor's agreement. A project name rather than a person's means a
  second contributor changes no header.
- **No signing secret in the env surface.** Phase 7's packaging list
  originally carried an `AUTH_SECRET`; there is nothing for it to
  protect, because a session is random and the database holds only its
  hash. An unused variable that looks like a security control is worse
  than no variable.
- **The container ships the CLI, not just the server.** Creating the
  first account, minting a key and running an import are node scripts
  over `lib/*.ts`, so the image carries `lib/`, `scripts/` and the
  production `node_modules` instead of a smaller standalone bundle that
  could not run any of them.
- **The visual language is set by the login page**: night-sky palette,
  Archivo for UI, Fraunces for display, all as CSS variables in
  `app/globals.css`. Phase 5 inherits it rather than re-deciding.

## Open questions

- CSV exports from the Steps template, which spread one case over
  several rows: phase 4 refuses them rather than reading half. Needs a
  second real export before it can be built — see `04` section 6.5.

## Questions since closed

- TestRail "baselines" (`suite_mode` 2): **resolved - they import flat.**
  Checked against a real instance with four mode-2 projects, one of them
  holding seventeen baselines: `get_suites` and `get_suite/:id` return
  the same nine fields, and none of them names a parent. So
  `baseline_of` cannot be filled from the API at all, and the import
  carries `is_baseline` with a report line instead of guessing. The
  column stays, because a suite created in MiniTCMS can still set it.
- Attachment import: **resolved, not yet built.** Storage was answered
  in phase 3 — local disk behind `saveAttachment`, `ATTACHMENTS_DIR`.
  The import rules are now settled too: 25 MB per file, no cap on the
  total, and a download that fails is a skip with a report line, never
  a failed import. A self-hoster sizes their volume from their own
  TestRail; this project does not guess a number for them. Stage 15 of
  `04-testrail-migration.md` is the work.
- BDD/Gherkin case template: **resolved — no parser, ever.** Gherkin
  imports and stays as text in `custom`, and an author who wants that
  style types it into the text field themselves. A parser would buy a
  structure nothing reads.
