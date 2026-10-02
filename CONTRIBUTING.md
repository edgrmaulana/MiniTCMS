# Contributing

Thanks for looking. This is a small project with opinions written down;
reading them first saves a round trip.

## The rules are in AGENTS.md

[`AGENTS.md`](AGENTS.md) is the real contract — where SQL lives, how
migration idempotency is kept, what a list has to do about paging, what a
comment is for. It is written for AI coding agents and applies verbatim to
humans. Skim it before the first patch; the review will quote it.

The short version:

- All SQL lives in `lib/db.ts`. Routes and pages never write raw SQL, and
  client code never imports `lib/db.ts`.
- Status, priority and type ids are constants in `lib/format.ts`, never
  literals.
- Results are append-only. No update, no delete, no route for either.
- Every list pages in SQL with `LIMIT ? OFFSET ?`, both ours and
  TestRail's.
- New or changed SQL ships with `EXPLAIN QUERY PLAN` run against
  realistic row counts, and the measured numbers go in the comment.
- Logic changes ship with tests in the same commit.
- No emojis in code, comments, commits or UI copy. This runs in CI.

## Before you open a pull request

```bash
npm install
npm run test
npm run lint
npm run build
```

All three have to pass. Then read your own diff: this repo is public, and
secrets, internal hostnames, company names or real customer data in a
fixture are the one class of mistake that cannot be taken back.

## Scope

Phases live in [`plan/`](plan/), one file each, and every file opens with
its status. If what you want to build is in a phase that is not done yet,
say so on an issue first — the plan file probably already has an opinion
about it, and that is cheaper to argue with than code.

Bug reports: what you ran, what happened, what you expected, and the
error verbatim. A database that refuses to open prints the schema version
it holds and the one the build wants; include both.
