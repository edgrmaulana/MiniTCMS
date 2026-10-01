# MiniTCMS

Open-source test case management, self-hosted, built to receive a
migration from TestRail.

Next.js 16 + SQLite. One process, one database file, one container.

Status: scaffolded. Implementation is planned in [`plan/`](plan/) —
start at [`plan/README.md`](plan/README.md). Rules for working in this
repo are in [`AGENTS.md`](AGENTS.md).

## Run

```bash
npm install
npm run dev
```

```bash
npm run test
npm run lint
npm run build
```

## TestRail migration

Not built yet. The design is in
[`plan/04-testrail-migration.md`](plan/04-testrail-migration.md): a
resumable, idempotent import over the TestRail API v2 that is lossless
or loud — every field either lands or shows up in the report.

Credentials go in `.env.local`, never in the repo:

```bash
TESTRAIL_HOST=https://example.testrail.io
TESTRAIL_USER=you@example.com
TESTRAIL_API_KEY=...
```

## License

TBD before the first public release — see `plan/07-release.md`.
