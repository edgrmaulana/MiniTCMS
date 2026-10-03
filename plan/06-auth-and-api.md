# Phase 6 — Auth and public API

Goal: stop the instance being wide open, and give CI a way to report
results.

**Status: done.** Sign-in shipped ahead of its phase; roles, keys and the
CI path landed together, because a role model decided one route at a time
is a role model with holes in it. Accounts are created by
`scripts/create-user.mjs`; `/api/users` reads the list for assignee
pickers and nothing writes a user over HTTP.

| Section | State |
|---------|-------|
| 1 Login | done |
| 2 Login page design | done |
| 3 Roles | done - ranked in `lib/format.ts`, enforced on every route |
| 4 Imported users | done |
| 5 API keys | done - `api_keys`, bearer auth, `npm run key` |
| 6 CI endpoints | done - results by case id, rate limited by key |
| 7 Tests | done - 401 swept over every route file, 403 and key paths covered |

Done when: every route requires a session or an API key, and a CI job
can post results for a run with a single authenticated call. Both hold.

Left for later, deliberately: account management from a screen (add a
user, change a password, reset somebody else's, list and kill sessions)
and a keys screen. Both are CLI-only today, which is enough for a
single-org self-host where the admin has the box.

---

## 1. Login — SHIPPED

Email + password, no self-service signup. Accounts come from an admin or
from the TestRail import.

| File | Owns |
|------|------|
| `lib/auth.ts` | scrypt hashing, token generation, input validation |
| `lib/session.ts` | cookie read/write, `currentUser()`, client address |
| `lib/db.ts` | `users`, `sessions`, `login_attempts` and their queries |
| `app/auth-actions.ts` | `login` / `logout` server actions |
| `app/login/page.tsx` | split-screen page, redirects away if signed in |
| `app/login/login-form.tsx` | the form, `useActionState` |
| `app/login/aurora.tsx` | WebGL2 hero |
| `scripts/create-user.mjs` | `npm run user:add` bootstrap |
| `app/api/helpers.ts` | `requireUser` (cookie then key), `requireRole`, 429 |
| `lib/rate-limit.ts` | per-key fixed window |
| `scripts/api-key.mjs` | `npm run key -- add/list/revoke` |

### Security decisions, and why

- **scrypt from `node:crypto`**, N=16384 r=8 p=1, 64-byte key, 16-byte
  random salt per user. Stdlib, no dependency. Stored as
  `scrypt$N$r$p$salt$hash` so the parameters can be raised later without
  invalidating existing hashes. Never lower N to speed up a test.
- **`timingSafeEqual`** for the comparison, never `===`, and the decoded
  key and salt lengths are pinned to what `hashPassword` writes.
  `Buffer.from` ignores invalid base64 instead of throwing, so without
  that check a truncated hash decoded to zero bytes, derived a
  zero-length key, compared equal, and **every password verified**. Any
  row the import left half-written would have been an account takeover.
- **Out-of-range scrypt parameters return false, never throw.** `N` must
  be a power of two in range and `r`/`p` small positive integers;
  otherwise node raises `RangeError` out of the server action and a
  single corrupt row turns sign-in into a 500 instead of a rejection.
- **Decoy verification.** An unknown email still runs a full scrypt
  verification against a throwaway hash, so a missing account costs the
  same wall time as a wrong password. Without it the form is a user
  directory with a stopwatch.
- **One error message** for wrong password, unknown account and disabled
  account: `Email or password is incorrect.` No enumeration, no hints.
- **Session tokens are 256 bits** of `randomBytes`, base64url. Only the
  SHA-256 **hash** is stored — a database read does not hand an attacker
  live sessions. No JWT, so there is nothing to forge and revocation is
  a `DELETE`.
- **Cookie**: `httpOnly`, `sameSite=lax`, `secure` in production,
  `path=/`, 7-day `maxAge`. SameSite plus Next's server-action origin
  check is the CSRF story; there is no separate token to get wrong.
- **Rate limiting** in SQLite: 8 failures per email per 15 minutes, and
  32 per client address over the same window. Counters clear on success,
  and rows outside the window are pruned on every attempt so an
  attacker-supplied identifier cannot grow the table without bound.
- **The address throttle is off unless you declare your topology.**
  `TRUSTED_PROXY_HOPS` defaults to 0, and at 0 `clientAddress()` returns
  `unknown` and the address bucket is skipped entirely. Measured, not
  assumed: Next passes the caller's `x-forwarded-for` straight through
  rather than appending the socket peer, so with no proxy in front the
  header is simply what the attacker typed. A spoofable per-IP limit is
  worse than none — it reads as protection while handing out a fresh
  bucket per request. Set `TRUSTED_PROXY_HOPS=1` behind one proxy you
  own and the entry that proxy appended is used. The per-email throttle
  is unaffected and always applies.
- **Password floor** 12 characters, ceiling 1024 (a scrypt DoS guard).
  No composition rules: length beats a required punctuation mark.
- **Bootstrap reads the password from stdin**, never argv, so it stays
  out of shell history and out of `ps`.
- **Session checks are server-side only.** `currentUser()` hits the
  database; nothing trusts a cookie's contents.

### Still open here

- Password change and admin-triggered reset.
- Session list and "sign out everywhere".
- Expired sessions are swept on sign-in rather than on a schedule. Good
  enough while people log in; a cron is the upgrade if an instance ever
  goes months between sign-ins.
- ~~`middleware.ts` so new routes are protected by default~~. Answered
  without one: `app/api/routes.test.ts` walks every `route.ts` under
  `app/api` with `import.meta.glob`, calls every handler it exports with
  no cookie and no key, and requires `401` from each. A route added later
  is covered the day it lands, and the rule stays in one place instead of
  being split between a matcher and the handlers. A middleware would also
  have had to re-read the session per request in the node runtime for no
  gain.

## 2. The login page design — SHIPPED

Modelled on the Amartha workbench console: split screen, visual left,
form right, lowercase slash wordmark (`minitcms / test console`).

- **Hero (left, `lg` and up).** A self-contained WebGL2 fragment shader:
  layered aurora light curtains warped by fbm value noise over a night
  sky of hashed, twinkling stars. The pointer sways the veil — cursor
  position feeds a smoothed uniform that shifts curtain phase and star
  parallax. One fullscreen triangle, no geometry, no texture, no
  library.
- **Degradation is mandatory, not polish.** No WebGL2 context, or a
  shader that fails to compile, leaves the CSS gradient underneath
  visible and the page works. `prefers-reduced-motion` draws one static
  frame and never starts the loop. Context loss is caught and the
  renderer restarts on restore. Below `lg` the hero is not rendered at
  all — a phone pays for neither the canvas nor the frames.
- **Form (right).** Email (`autoComplete="username"`), password
  (`autoComplete="current-password"`), one `Sign in` button that
  disables while pending. Errors via `role="alert"` and
  `aria-describedby`, never colour alone.
- **Type.** Archivo for UI, Fraunces for display. Deliberately not
  Inter, not Geist, not Space Grotesk. Archivo was picked for 12px
  legibility in the dense tables phase 5 will build, not for this page.
- **Colour.** Night blue-black ground, dominant aurora teal, cold violet
  mid, one sharp magenta reserved for errors. All CSS variables in
  `app/globals.css` — this is the palette the rest of the app inherits.
- **Motion.** One staggered page-load reveal via `animation-delay`.
  Nothing animates between a keystroke and a response.

## 3. Roles

Three, in `lib/format.ts` as `USER_ROLES`, and enforced by a
`CHECK (role IN (...))` on the column so the phase 4 import cannot write
a fourth one from somebody's custom field:

- `admin` — everything, including import and user management.
- `lead` — create and close runs, edit cases, no user management.
- `tester` — read cases, record results. Cannot delete.

Shipped as a **ladder, not a set**: `ROLE_RANK` in `lib/format.ts` plus
`roleAtLeast(role, minimum)`, and `requireRole(minimum)` in
`app/api/helpers.ts` names the rung a route needs. A list of acceptable
roles is the thing somebody forgets to extend when a fourth role lands,
and forgetting it fails open.

Where each rung lands:

| Rung | Routes |
|---|---|
| `tester` (any session) | every `GET`, `POST /api/results`, `POST /api/runs/[id]/tests/status`, `POST /api/attachments` |
| `lead` | writes to projects, suites, sections, cases, bulk case edits, milestones, plans, `POST /api/runs`, `PATCH /api/runs/[id]`, `POST /api/runs/[id]/tests/assign` |
| `admin` | `DELETE /api/runs/[id]`, `POST /api/case-fields`, every `/api/migrate` route |

Three deviations from the sketch above, each for a reason:

- **The import is admin-only**, not admin-or-lead as the first cut of the
  routes had it. It writes across every project in the instance and can
  overwrite migrated rows in all of them.
- **A custom field definition is admin.** It is the shape of every case in
  the instance, not one case's content - the same rung as an import.
- **Closing and reopening a run are the same rung.** The earlier split
  (lead closes, admin reopens) made a lead unable to undo their own
  mistake, which is not a safety property, just an errand for somebody
  else.

The role check runs **before the body is read**, so a refusal never
depends on the payload parsing. Screens hide what a role cannot use -
the bulk bar on `/cases`, Save on a case, Close on a run, the Import link
in the rail - and every route checks again regardless.

Still no permission matrix, no per-project ACL, no custom roles.

## 4. Imported users

TestRail users land with `password_hash = NULL` and cannot sign in until
an admin sets a password — a NULL hash never verifies, it does not match
an empty password. They exist so results attribute correctly, which is
the only reason phase 4 imports them.

## 5. API keys — SHIPPED

`api_keys(user_id, name, key_hash, created_on, last_used_on, revoked_on)`,
schema version 11.

- `Authorization: Bearer mtk_...`, 256 bits of `randomBytes` behind a
  visible prefix so a key that leaks into a log can be grepped for and
  recognised. Only the SHA-256 hash is stored, so minting prints it once
  and there is no command that can show it again.
- **A key carries no permissions of its own.** `findApiKeyUser` joins
  `users` and takes the role from there, so demoting an account demotes
  its keys, and deactivating one kills them.
- **Revoking is a timestamp, not a delete**: a key that ran for six
  months stays in the audit trail after it stops working. Revoking twice
  is a `409`, not a success that changed nothing.
- `last_used_on` is stamped by one `UPDATE` with the staleness in the
  `WHERE`, at most once a minute per key. Writing on every request would
  have put a write on the read path, which is what SQLite serialises on.
- **Rate limited per key**: 300 requests a minute, `429` with
  `Retry-After` over that. Fixed window in `lib/rate-limit.ts`, in the
  app process and not in a table - a counter row per request is the
  problem rather than the fix. The ceiling is written down: two processes
  get an allowance each, and the upgrade is a bucket table keyed by
  `(key_hash, window_start)`. A session cookie is never rate limited.
- **CLI, not a screen**: `npm run key -- add|list|revoke`. Minting a
  credential is an operator action that happens once per CI job, and a
  key printed into a terminal does not pass through a browser history or
  a React state tree on the way.

## 6. CI-facing endpoints — SHIPPED

```text
POST  /api/runs                     # create a run from a case filter   (lead)
POST  /api/results                  # bulk results, by test id or case id
PATCH /api/runs/[id]                # close the run                     (lead)
GET   /api/runs/[id]/summary
```

All four existed from phase 3; what phase 6 added is the credential, the
role, and `caseId`:

```json
{ "runId": 12, "results": [{ "caseId": 1041, "statusId": 1 }] }
```

`runId` may sit at the top level or on each entry. Resolution happens in
`resolveResultTargets` inside the same transaction as the insert, so the
test a result lands on cannot change between the lookup and the write. A
case that is not in the run is a `404` naming both ids. An entry carrying
both a `testId` and a `caseId` is a `400` rather than a precedence rule -
accepting both and preferring one means a reporter with a stale test id
silently records against the wrong test.

Measured over 200,000 tests (20,000 cases across 10 runs): the lookup
rides `idx_tests_case` at 0.002ms, and 500 results posted by case id take
3.6ms against 2.6ms by test id. One millisecond for the batch is the
price of not making CI resolve ids first.

## 7. Tests

Shipped in `lib/auth.test.ts` and `lib/db.test.ts`: round-trip hashing,
per-hash salting, the password never appearing in the stored string,
malformed hashes returning false instead of throwing, token uniqueness
and hashing, email and password validation, expired sessions, sessions
for deactivated and deleted users, and the attempt window.

Added in `app/api/routes.test.ts`, `lib/db.test.ts` and
`lib/rate-limit.test.ts`:

- **The 401 sweep.** Every `route.ts` under `app/api`, found with
  `import.meta.glob`, every handler it exports, no cookie and no key, one
  assertion: `401`. A route that validated its input before checking the
  session would answer `400` and fail this. A session token that is not
  in the database is refused too. The file count is taken a second time
  from disk and the two must match, because a glob that quietly stopped
  matching would shrink the sweep to nothing and still pass.
- **The rung table.** Every write path paired with the role it needs, and
  asserted from both sides: refused one rung below, not refused at its own.
  One side alone is not enough - a rung set too low fails open, one set too
  high is a screen nobody can use. Checked by mutation: dropping
  `POST /api/cases/bulk` back to any session fails this test.
- `tester` editing a case is `403`; `tester` creating a run is `403` and
  `lead` is `201`; `lead` listing imports is `403` and `admin` is `200`;
  `lead` deleting a run is `403`; `tester` recording a result is `201`,
  because that is the job.
- A bearer key authenticates; a revoked key, a key whose owner was
  deactivated, and a made-up key are all `401`. A key gets exactly its
  owner's role. A cookie wins over a bearer header when both are sent.
- `listApiKeys` never returns `key_hash`, and no row serialises anything
  starting `mtk_`.
- `touchApiKey` stamps, then leaves the stamp alone inside the window.
- An exhausted key answers `429` with a positive `Retry-After`, on its
  own allowance, while another key and the cookie path are unaffected.
- Results by case id: resolved to the right test, `404` for a case that
  is not in the run, `400` for a case id with no run and for an entry
  naming both ids.

`vitest.config.mts` exists only so a test can import a route the way the
route imports itself - vitest does not read tsconfig paths, and the
routes use `@/lib/...`.

## 8. Checks

`npm run test`, `npm run lint`, `npm run build`, plus a manual pass of
the auth flow in a fresh browser profile.

Phase 6 was verified live as well, against `next start` on a seeded
database rather than only through mocked headers: no credential `401`,
bogus bearer `401`, lead key `200`, tester editing a case `403`, lead
editing it `200`, tester closing a run `403`, lead deleting a run `403`,
lead listing imports `403`, admin `200`, tester key creating a run `403`,
lead key `201`, a result posted by case id `{"recorded":1}`, an unknown
case `Case 99999 is not in run 1`, and 310 requests on one key answering
299 x `200` then `429` with `Retry-After: 50` while the cookie path stayed
`200`.
