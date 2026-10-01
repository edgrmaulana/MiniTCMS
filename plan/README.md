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
| 2 | `02-case-repository.md` | Projects, suites, nested sections, cases, custom fields | next |
| 3 | `03-execution.md` | Milestones, plans, runs, tests, append-only results | not started |
| 4 | `04-testrail-migration.md` | TestRail client, field mapping, resumable import, report | not started |
| 5 | `05-ui.md` | App shell and the five screens that make it usable | partial |
| 6 | `06-auth-and-api.md` | Login, roles, public REST API, CI reporters | partial |
| 7 | `07-release.md` | Docker, CI, license, contributor docs, v0.1.0 | not started |

Each phase file opens with its own status and a per-section breakdown.
Update them in the same turn the work lands, or this table starts
lying.

Phases 1→4 are strictly ordered. Phase 5 can start once phase 2 lands.
Phase 7 is last.

Phase 6 jumped the queue: the login page was built first, which pulled
the `users`, `sessions` and `login_attempts` slice of the phase 1 schema
forward with it. Phase 1 has since landed the rest, at schema version 3.

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
- **Results append-only.** No update, no delete. Current status is the
  latest result.
- **No ORM.** Hand-written SQL in `lib/db.ts`. The schema is ~15 tables
  and it is not going to surprise anyone.
- **Sessions in the database, not a JWT.** Only the token hash is
  stored, so revocation is a `DELETE` and a leaked database dump does
  not hand over live logins. Details in `06-auth-and-api.md`.
- **The visual language is set by the login page**: night-sky palette,
  Archivo for UI, Fraunces for display, all as CSS variables in
  `app/globals.css`. Phase 5 inherits it rather than re-deciding.

## Open questions

- Attachment storage: local disk vs S3-compatible. Default local;
  decide the interface in phase 3, not before.
- TestRail "baselines" (`suite_mode` 2): import as plain suites with a
  `baseline_of` pointer, or flatten? Decide against a real export in
  phase 4.
- BDD/Gherkin case template: TestRail has one, we have no steps parser.
  Likely stored as text in phase 2, structured later if asked.
