# Phase 7 — Release

Goal: someone who is not us can self-host this and migrate off TestRail
without asking a question.

Can overlap phase 6.

Done when: a stranger follows `README.md` on a clean machine and gets a
running instance with their TestRail data in it.

## 1. Packaging

- One `Dockerfile`, multi-stage, `node:lts-slim`. `better-sqlite3` is
  native — build it in the build stage and copy the built module, or the
  image breaks on a different libc.
- One `docker-compose.yml`: the app, a named volume for `data.db` and
  attachments, env vars documented inline. No reverse proxy, no
  Postgres, no Redis in the default compose file. Add nothing a first-run
  user does not need.
- Env surface, all documented: `SQLITE_FILE`, `ATTACHMENTS_DIR`,
  `AUTH_SECRET`, `TESTRAIL_HOST`, `TESTRAIL_USER`, `TESTRAIL_API_KEY`,
  `TESTRAIL_RPS`.

## 2. CI

GitHub Actions, one workflow: `npm ci`, `npm run test`, `npm run lint`,
`npm run build`. On tag, build and push the image. Nothing else — no
coverage gate, no matrix across four Node versions, no release bot.

## 3. Docs

- `README.md` — what it is, what it is not, run in 3 commands, migrate
  in 2. The TestRail section is the headline, not an appendix.
- `docs/migration.md` — getting an API key, running a dry-run, reading
  the report, resuming, what does not come across and why.
- `CONTRIBUTING.md` — short. Points at `AGENTS.md` for the actual rules.
- `LICENSE` — MIT unless there is a reason otherwise. Decide before the
  first public commit; relicensing later needs every contributor's
  agreement.

## 4. Pre-release review

- `grep` the tree for hardcoded hosts, emails, company names, and real
  case titles. This repo is public and a migration tool is exactly the
  kind of code that ends up with a customer's instance URL in a fixture.
- Confirm no `data.db`, no `.env.local`, no attachments directory is
  tracked.
- Read the whole diff of the initial public commit. Once it is pushed it
  is permanent.

## 5. v0.1.0

Tag when: phases 1-4 work against a real instance, phase 6 auth is on,
and the Docker image runs clean from the compose file. Phase 5 polish
and the CSV fallback can land after.
