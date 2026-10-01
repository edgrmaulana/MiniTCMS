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

# Create the first account. The password is read from stdin, so it never
# lands in your shell history. Minimum 12 characters.
npm run user:add -- you@example.com admin

npm run dev          # http://localhost:3000/login
```

```bash
npm run test
npm run lint
npm run build
```

`SQLITE_FILE` overrides the database path (default `./data.db`).

## Sign-in

Email and password, sessions in SQLite, scrypt hashes, one deliberately
vague error message. There is no self-service signup: accounts come from
`npm run user:add` or from the TestRail import. What is built and what
is not is listed in
[`plan/06-auth-and-api.md`](plan/06-auth-and-api.md).

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
