# Phase 6 — Auth and public API

Goal: stop the instance being wide open, and give CI a way to report
results.

Depends on phases 2 and 3. Deliberately late: a single-user local
instance is useful without it, and auth designed before the data model
settles gets redesigned.

Done when: every route requires a session or an API key, and a CI job
can post results for a run with a single authenticated call.

## 1. Auth

- Email + password, `scrypt` hashes, sessions in an http-only cookie.
  No SSO, no SAML, no magic links. A self-hosted team of 30 does not
  need an identity provider and we are not going to maintain one.
- First-run bootstrap: if `users` is empty, the first registration
  becomes admin. After that, admin invites.
- Imported TestRail users land with `password_hash = NULL` and cannot
  log in until they set a password. They exist so results attribute
  correctly, which is the only reason phase 4 imports them.

## 2. Roles

Three, hard-coded in `lib/format.ts`:

- `admin` — everything, including import and user management.
- `lead` — create and close runs, edit cases, no user management.
- `tester` — read cases, record results. Cannot delete.

Checked in one `requireRole(session, role)` helper called at the top of
each route. No permission matrix, no per-project ACL, no custom roles
until someone asks with a real reason.

## 3. API keys

- Per-user keys for CI, `Authorization: Bearer <key>`. Hashed at rest,
  shown once at creation.
- Same role checks as a session. A key cannot do more than its owner.
- `lastUsedAt` recorded so dead keys can be found and revoked.

## 4. CI-facing endpoints

The thin surface a reporter actually needs:

```text
POST /api/runs                     # create a run from a case filter
POST /api/results                  # bulk results, by test id or case id
PATCH /api/runs/[id]               # close the run
GET  /api/runs/[id]/summary
```

`POST /api/results` accepts `case_id` as well as `test_id` so a reporter
does not have to resolve test ids first. That resolution happens in
`lib/db.ts` in the same transaction as the insert.

Rate limit by key: a runaway CI job should get 429, not take the
instance down.

## 5. Tests

- Unauthenticated request to every route shape returns 401.
- `tester` posting a case edit returns 403.
- Bulk results by `case_id` resolve to the right tests in the right run.
- API key hash never appears in any response body.

## 6. Checks

`npm run test`, `npm run lint`, `npm run build`, plus a manual pass of
the auth flow in a fresh browser profile.
