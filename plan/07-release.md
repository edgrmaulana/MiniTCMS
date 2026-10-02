# Phase 7 — Release

Goal: someone who is not us can self-host this and migrate off TestRail
without asking a question.

Can overlap phase 6.

**Status: done, bar the v0.1.0 tag.** `Dockerfile`,
`docker-compose.yml`, one GitHub Actions workflow, MIT `LICENSE`,
`CONTRIBUTING.md` and `docs/migration.md` all ship. The tag is held back
on purpose - see section 5.

Done when: a stranger follows `README.md` on a clean machine and gets a
running instance with their TestRail data in it.

| Section | State |
|---------|-------|
| 1 Packaging | done - multi-stage image, one volume, env documented inline |
| 2 CI | done - checks on `main`, every PR and every tag; image on a `v*` tag |
| 3 Docs | done - `README.md`, `docs/migration.md`, `CONTRIBUTING.md`, MIT |
| 4 Pre-release review | done - swept for secrets, hosts and names; the attachment claim corrected in three files |
| 5 v0.1.0 | not tagged - the real-instance run is still outstanding |

Four decisions this phase took, each away from what the section below
sketched:

- **No `AUTH_SECRET`.** The env list in section 1 named one. There is
  nothing for it to protect: a session is 256 bits of randomness and the
  database holds only its SHA-256 hash, so no cookie is signed and there
  is no key to rotate. Shipping an unused variable invites somebody to
  set it and believe it did something. The real surface is `SQLITE_FILE`,
  `ATTACHMENTS_DIR`, `MAX_ATTACHMENT_BYTES`, `TRUSTED_PROXY_HOPS` and the
  four `TESTRAIL_*`.
- **The image is not a `next build` standalone bundle**, which would be
  the smaller option. Creating the first account, minting a key and
  running an import are node scripts over `lib/*.ts`, and a standalone
  bundle has neither the source nor a resolvable `better-sqlite3` for
  them. The CLI is part of the product, so the image carries the
  production `node_modules`, `lib/` and `scripts/`.
- **TestRail credentials are not in the compose file's `environment`.**
  The import is a terminal job, not something the server does, so the
  compose file documents passing them on the `docker compose run` that
  starts an import instead of keeping an API key in the server process
  for its whole life.
- **`npm ci --omit=dev` where the obvious move was `npm prune`.** Prune
  re-resolves the whole tree and stops on a devDependency peer range
  (`vitest` wants `@types/node` >= 22, the repo pins ^20), which is a
  thing to fix in its own commit rather than inside an image build. The
  second lockfile install runs in the build stage, with the toolchain, so
  `better-sqlite3` is still compiled against the libc it will run on.

The image is **922MB**, of which 351MB is the production
`node_modules` (203MB of it `next` itself) and 62MB the build output.
A `next build` standalone bundle would cut most of that; it also cannot
run the CLI, which is why it was not taken. If the size starts to matter,
the upgrade path is a standalone bundle plus `lib/`, `scripts/` and a
copied `better-sqlite3` beside it.

Verified against the running container, not just built: `/login` 200,
`/api/projects` 401 anonymous, `npm run user:add` and `npm run key`
through `docker compose exec`, a `POST /api/projects` with the minted key
201, and the row still there after `docker compose restart` - so the
volume, the non-root user (`uid=1000(node)`, `/app/data` owned by it) and
the WAL files all behave. `next.config.ts` loads with `typescript`
pruned out, which was the one thing the pruned image could have broken.

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

Shipped as `.github/workflows/ci.yml`: a `checks` job on every push to
`main`, every pull request and every tag, and an `image` job gated on
`refs/tags/v*` that pushes to `ghcr.io/<owner>/<repo>` with
`GITHUB_TOKEN`. A branch build of an image nobody pulls is CI minutes
spent on nothing.

The gap that buys: nothing builds the image until a tag, so a Dockerfile
broken by a dependency change surfaces at the worst moment. Build it
locally when you touch it - `docker compose up -d --build` is the same
path - and if that bites once, add a `paths`-filtered build to the
checks job rather than building every push.

## 3. Docs

- `README.md` — what it is, what it is not, run in 3 commands, migrate
  in 2. The TestRail section is the headline, not an appendix.
- `docs/migration.md` — getting an API key, running a dry-run, reading
  the report, resuming, what does not come across and why.
- `CONTRIBUTING.md` — short. Points at `AGENTS.md` for the actual rules.
- `LICENSE` — MIT unless there is a reason otherwise. Decide before the
  first public commit; relicensing later needs every contributor's
  agreement.

**Decided: MIT**, held by "MiniTCMS contributors" rather than a person,
so a second contributor needs no header change. `README.md` leads with
TestRail and links `docs/migration.md` for the step-by-step; the doc
covers the key, the dry run, every section of the report, resuming by
import run id, the two-sources trap and what does not come across.

## 4. Pre-release review

- `grep` the tree for hardcoded hosts, emails, company names, and real
  case titles. This repo is public and a migration tool is exactly the
  kind of code that ends up with a customer's instance URL in a fixture.
- Confirm no `data.db`, no `.env.local`, no attachments directory is
  tracked.
- Read the whole diff of the initial public commit. Once it is pushed it
  is permanent.

The sweep found no credential, no internal host and no company name:
every host in the tree is `example.com`, `example.testrail.io` or
`localhost`, and the one real address is the sample in a test fixture's
own `example.com` domain. Nothing under `data/`, no `.env*` and no
`data.db*` is tracked.

It did find one claim the code does not support, stated in three files
and corrected in all of them: `README.md`, `plan/README.md` and
`plan/04-testrail-migration.md` all said imported attachment rows come
across without their bytes, when the API path imports neither - there is
no attachment stage and no client call for one. The only `addSkipped`
site in the tree is the CSV reader's `Attachments` column, which is why
an API report has no skipped section at all.

## 5. v0.1.0

Tag when: phases 1-4 work against a real instance **and against a real
CSV export**, phase 6 auth is on, and the Docker image runs clean from
the compose file. Phase 5 polish can land after. The CSV path is not
cuttable: for a team without API access it is the whole product.

**Not tagged.** Auth is on and the image runs clean from the compose
file - account created, key minted, write accepted, data still there
after a restart - but
the gate nobody can wave through is the first one: no API dry run has
been made against a live TestRail instance, which is also the last open
item in `plan/04-testrail-migration.md` section 9. `v0.1.0` waits for
that run and for one real CSV export from somebody else's instance.
Tagging first would publish an image whose headline feature has never
touched the system it migrates from.
