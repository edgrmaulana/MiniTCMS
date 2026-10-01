# Phase 6 — Auth and public API

Goal: stop the instance being wide open, and give CI a way to report
results.

Partly shipped ahead of its phase: **sign-in works today**. Sections 1-4
below describe what is built; sections 5-7 are the remaining work.

Done when: every route requires a session or an API key, and a CI job
can post results for a run with a single authenticated call.

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

### Security decisions, and why

- **scrypt from `node:crypto`**, N=16384 r=8 p=1, 64-byte key, 16-byte
  random salt per user. Stdlib, no dependency. Stored as
  `scrypt$N$r$p$salt$hash` so the parameters can be raised later without
  invalidating existing hashes. Never lower N to speed up a test.
- **`timingSafeEqual`** for the comparison, never `===`.
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
- **Rate limiting** in SQLite: 8 failures per email per 15 minutes,
  32 per client address over the same window. Counters clear on success.
  The address is secondary on purpose — `x-forwarded-for` is spoofable
  unless you own the proxy, so it tightens the screw but never holds the
  door alone.
- **Password floor** 12 characters, ceiling 1024 (a scrypt DoS guard).
  No composition rules: length beats a required punctuation mark.
- **Bootstrap reads the password from stdin**, never argv, so it stays
  out of shell history and out of `ps`.
- **Session checks are server-side only.** `currentUser()` hits the
  database; nothing trusts a cookie's contents.

### Still open here

- Password change and admin-triggered reset.
- Session list and "sign out everywhere".
- `deleteExpiredSessions` exists but nothing calls it on a schedule.
- `middleware.ts` so new routes are protected by default rather than by
  remembering to call `currentUser()`.

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

Three, in `lib/db.ts` as the `UserRole` type:

- `admin` — everything, including import and user management.
- `lead` — create and close runs, edit cases, no user management.
- `tester` — read cases, record results. Cannot delete.

To build: one `requireRole(session, role)` helper called at the top of
each route. No permission matrix, no per-project ACL, no custom roles
until someone asks with a real reason.

## 4. Imported users

TestRail users land with `password_hash = NULL` and cannot sign in until
an admin sets a password — a NULL hash never verifies, it does not match
an empty password. They exist so results attribute correctly, which is
the only reason phase 4 imports them.

## 5. API keys — TO BUILD

- Per-user keys for CI, `Authorization: Bearer <key>`. Generated like a
  session token and stored the same way: SHA-256 hash only, shown once
  at creation.
- Same role checks as a session. A key cannot do more than its owner.
- `last_used_on` recorded so dead keys can be found and revoked.

## 6. CI-facing endpoints — TO BUILD

```text
POST  /api/runs                     # create a run from a case filter
POST  /api/results                  # bulk results, by test id or case id
PATCH /api/runs/[id]                # close the run
GET   /api/runs/[id]/summary
```

`POST /api/results` accepts `case_id` as well as `test_id` so a reporter
does not have to resolve test ids first. That resolution happens in
`lib/db.ts` in the same transaction as the insert.

Rate limit by key: a runaway CI job should get 429, not take the
instance down.

## 7. Tests

Shipped in `lib/auth.test.ts` and `lib/db.test.ts`: round-trip hashing,
per-hash salting, the password never appearing in the stored string,
malformed hashes returning false instead of throwing, token uniqueness
and hashing, email and password validation, expired sessions, sessions
for deactivated and deleted users, and the attempt window.

Still to write:

- Unauthenticated request to every route shape returns 401.
- `tester` posting a case edit returns 403.
- Bulk results by `case_id` resolve to the right tests in the right run.
- API key hash never appears in any response body.

## 8. Checks

`npm run test`, `npm run lint`, `npm run build`, plus a manual pass of
the auth flow in a fresh browser profile.
