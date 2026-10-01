# MiniTCMS

Open-source test case management, self-hosted, built to receive a
migration from TestRail.

Next.js 16 + SQLite. One process, one database file, one container.

## Status

Early. Sign-in works and the data model is complete; the screens that
use it are not built yet.

| Phase | | |
|---|---|---|
| 1 | Foundation — SQLite layer, schema, constants, test harness | **done** |
| 2 | Case repository — projects, suites, sections, cases, custom fields | next |
| 3 | Execution — milestones, plans, runs, append-only results | not started |
| 4 | TestRail migration — client, mapping, resumable import, report | not started |
| 5 | UI — app shell and the five screens | palette and type only |
| 6 | Auth and public API — login, roles, REST API, CI reporters | login done |
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
npm run test
npm run lint
npm run build
```

There is no migration path before the first release. When the schema
version moves, an older database is refused on open, untouched — delete
`data.db*` and create your account again.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `SQLITE_FILE` | `./data.db` | Database path |
| `TRUSTED_PROXY_HOPS` | `0` | How many reverse proxies you run in front of the app |
| `TESTRAIL_HOST` | — | e.g. `https://example.testrail.io` (phase 4) |
| `TESTRAIL_USER` | — | TestRail account email (phase 4) |
| `TESTRAIL_API_KEY` | — | API key, not a password (phase 4) |

TestRail credentials go in `.env.local`, never in the repo.

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
until an admin sets one; they exist so results attribute correctly.
What is built and what is not is listed in
[`plan/06-auth-and-api.md`](plan/06-auth-and-api.md).

## Data model

Schema version 4: 17 tables, created in one block and guarded by a
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

Not built yet. The design is in
[`plan/04-testrail-migration.md`](plan/04-testrail-migration.md): a
resumable, idempotent import over the TestRail API v2 that is lossless
or loud — every field either lands or shows up in the report.

## License

TBD before the first public release — see
[`plan/07-release.md`](plan/07-release.md).
