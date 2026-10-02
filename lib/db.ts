import Database from "better-sqlite3";
import {
  ATTACHMENT_ENTITIES,
  BUILT_IN_STATUSES,
  CaseFieldError,
  MAX_MILESTONE_LEVELS,
  MAX_SECTION_LEVELS,
  RESULT_STATUS,
  SUITE_MODE,
  USER_ROLES,
  clampPage,
  clampPageSize,
  isAssignableStatus,
  needsComment,
  offsetFor,
  runProgress,
  validateCustom,
  type AttachmentEntity,
  type ActivityRow,
  type ApiKeyRow,
  type AssignableUser,
  type AttachmentRow,
  type CaseFieldRow,
  type CaseRow,
  type ImportRunRow,
  type ImportState,
  type ListResult,
  type MilestoneRow,
  type PlanRow,
  type ProjectOverview,
  type ProjectRow,
  type ResultRow,
  type RunProgress,
  type RunRow,
  type SectionRow,
  type SectionTreeRow,
  type StatusCount,
  type StatusRow,
  type TestRow,
  type SessionUser,
  type SuiteMode,
  type SuiteRow,
  type UserRole,
  type UserRow,
} from "./format.ts";

export const SCHEMA_VERSION = 11;

// Interpolated at module load from constants, never from a request value.
const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

const ROLE_VALUES = quoted(USER_ROLES);
const ATTACHMENT_ENTITY_VALUES = quoted(ATTACHMENT_ENTITIES);
const SUITE_MODE_VALUES = Object.values(SUITE_MODE).join(", ");

// Read and compared before the rest of the schema is applied, so a database
// from another build is refused without being touched.
const VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'tester' CHECK (role IN (${ROLE_VALUES})),
  is_active     INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT,
  created_on    INTEGER NOT NULL,
  source        TEXT,
  source_id     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email  ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_source ON users(source, source_id);
/*
  An expression index, because the lookup is case-insensitive: a CSV export
  carries a display name, not an email, and "Ana" has to find "ana". An
  index on name alone cannot answer lower(name) = ? and the query scanned
  the table - 261us over 500 users, growing with the user list. Seek: 44us.
*/
CREATE INDEX IF NOT EXISTS idx_users_name_lower ON users(lower(name));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_on INTEGER NOT NULL,
  expires_on INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_on);

CREATE TABLE IF NOT EXISTS login_attempts (
  id           INTEGER PRIMARY KEY,
  identifier   TEXT NOT NULL,
  attempted_on INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(identifier, attempted_on);

/*
  CI credentials. Stored exactly like a session - only the SHA-256 hash, never
  the key - so a database dump does not hand over working credentials, and a
  revoke is a timestamp rather than a delete: a key that was used for six
  months is part of the audit trail even after it stops working.

  A key carries no permissions of its own. Every check reads the owner's role
  through the join below, so revoking a role revokes it everywhere at once and
  a key can never outrank the person who made it.
*/
CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  created_on   INTEGER NOT NULL,
  last_used_on INTEGER,
  revoked_on   INTEGER
);
/*
  The hash index is the authentication path and runs on every API request:
  SEARCH api_keys USING INDEX idx_api_keys_hash, 0.014ms over 500 keys.

  The second carries the id so one owner's keys come back in order without a
  sort: SEARCH api_keys USING COVERING INDEX idx_api_keys_user, no temp B-tree,
  0.035ms for a page of 25. On user_id alone the same list sorted every page.
*/
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user        ON api_keys(user_id, id);

CREATE TABLE IF NOT EXISTS statuses (
  id          INTEGER PRIMARY KEY,
  system_name TEXT NOT NULL,
  label       TEXT NOT NULL,
  color       TEXT,
  is_untested INTEGER NOT NULL DEFAULT 0,
  is_final    INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_statuses_name ON statuses(system_name);

CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  announcement TEXT,
  suite_mode   INTEGER NOT NULL DEFAULT 1 CHECK (suite_mode IN (${SUITE_MODE_VALUES})),
  is_completed INTEGER NOT NULL DEFAULT 0,
  created_on   INTEGER NOT NULL,
  source       TEXT,
  source_id    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_source ON projects(source, source_id);

CREATE TABLE IF NOT EXISTS suites (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  is_baseline INTEGER NOT NULL DEFAULT 0,
  baseline_of INTEGER REFERENCES suites(id) ON DELETE SET NULL,
  source      TEXT,
  source_id   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_suites_project       ON suites(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suites_source ON suites(source, source_id);

CREATE TABLE IF NOT EXISTS sections (
  id            INTEGER PRIMARY KEY,
  suite_id      INTEGER NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  parent_id     INTEGER REFERENCES sections(id) ON DELETE CASCADE,
  depth         INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0 AND depth < ${MAX_SECTION_LEVELS}),
  display_order INTEGER NOT NULL DEFAULT 0,
  name          TEXT NOT NULL,
  description   TEXT,
  source        TEXT,
  source_id     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sections_suite         ON sections(suite_id);
CREATE INDEX IF NOT EXISTS idx_sections_parent        ON sections(parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sections_source ON sections(source, source_id);

CREATE TABLE IF NOT EXISTS milestones (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id    INTEGER REFERENCES milestones(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  due_on       INTEGER,
  started_on   INTEGER,
  is_completed INTEGER NOT NULL DEFAULT 0,
  source       TEXT,
  source_id    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_milestones_project       ON milestones(project_id);
CREATE INDEX IF NOT EXISTS idx_milestones_parent        ON milestones(parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_milestones_source ON milestones(source, source_id);

CREATE TABLE IF NOT EXISTS case_fields (
  id          INTEGER PRIMARY KEY,
  system_name TEXT NOT NULL,
  label       TEXT NOT NULL,
  type        TEXT NOT NULL,
  is_global   INTEGER NOT NULL DEFAULT 1,
  configs     TEXT,
  source      TEXT,
  source_id   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_case_fields_name   ON case_fields(system_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_case_fields_source ON case_fields(source, source_id);

CREATE TABLE IF NOT EXISTS cases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id   INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  suite_id     INTEGER NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  template_id  INTEGER NOT NULL DEFAULT 1,
  type_id      INTEGER,
  priority_id  INTEGER,
  refs         TEXT,
  estimate     TEXT,
  milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
  custom       TEXT,
  is_deleted   INTEGER NOT NULL DEFAULT 0,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_on   INTEGER NOT NULL,
  updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_on   INTEGER NOT NULL,
  source       TEXT,
  source_id    INTEGER
);
/*
  Both of these are wider than they look like they need to be, and both were
  measured on 100k cases before being widened:

  idx_cases_suite covers listCases down to its ORDER BY. Without the trailing
  (section_id, id) SQLite answers every page with USE TEMP B-TREE FOR ORDER
  BY - sorting all 100k matching rows to return 25. Page 1 went 116ms -> 0.2ms,
  page 1000 40ms -> 0.6ms.

  idx_cases_section carries is_deleted so sectionTree's per-section count is a
  covering index scan instead of a row fetch per case. The tree over 200
  sections went 207ms -> 1.6ms.
*/
CREATE INDEX IF NOT EXISTS idx_cases_section       ON cases(section_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_cases_suite         ON cases(suite_id, is_deleted, section_id, id);
CREATE INDEX IF NOT EXISTS idx_cases_title         ON cases(title);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_source ON cases(source, source_id);

CREATE TABLE IF NOT EXISTS plans (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
  is_completed INTEGER NOT NULL DEFAULT 0,
  created_on   INTEGER NOT NULL,
  source       TEXT,
  source_id    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plans_project       ON plans(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_source ON plans(source, source_id);

CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id     INTEGER NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  plan_id      INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  config       TEXT,
  include_all  INTEGER NOT NULL DEFAULT 1,
  is_completed INTEGER NOT NULL DEFAULT 0,
  created_on   INTEGER NOT NULL,
  source       TEXT,
  source_id    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_project       ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_plan          ON runs(plan_id);
/*
  Without this the milestone rollup inverts its join and scans the whole tests
  table - 2.05ms for a milestone holding three tests, growing with the
  database rather than with the milestone. With it, 0.10ms and flat.
*/
CREATE INDEX IF NOT EXISTS idx_runs_milestone     ON runs(milestone_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_source ON runs(source, source_id);

CREATE TABLE IF NOT EXISTS tests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  case_id        INTEGER REFERENCES cases(id) ON DELETE SET NULL,
  title_snapshot TEXT NOT NULL,
  status_id      INTEGER NOT NULL DEFAULT ${RESULT_STATUS.untested} REFERENCES statuses(id),
  assigned_to    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source         TEXT,
  source_id      INTEGER
);
/*
  Two indexes on the same leading column, and both earn their place - measured
  on a 100k-test run:

  idx_tests_run answers runSummary from the index alone, and is what the
  planner picks when a status filter is selective enough to seek on.

  idx_tests_order serves the run detail screen's default view, which is
  ordered by id. Without it that list came back through USE TEMP B-TREE FOR
  ORDER BY at 90ms a page, and page 2000 at 35ms; with it, 0.05ms and 0.88ms.

  Deliberately no ANALYZE anywhere in this file. With stats collected the
  planner switches a rare-status filter from an index seek to a full scan and
  that query goes 0.11ms -> 3.92ms. The no-stats heuristics are the better
  ones here, and they are what ships.
*/
CREATE INDEX IF NOT EXISTS idx_tests_run           ON tests(run_id, status_id);
CREATE INDEX IF NOT EXISTS idx_tests_order         ON tests(run_id, id);
CREATE INDEX IF NOT EXISTS idx_tests_case          ON tests(case_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tests_source ON tests(source, source_id);

CREATE TABLE IF NOT EXISTS results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id     INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  status_id   INTEGER NOT NULL REFERENCES statuses(id),
  comment     TEXT,
  version     TEXT,
  elapsed     TEXT,
  defects     TEXT,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  custom      TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_on  INTEGER NOT NULL,
  source      TEXT,
  source_id   INTEGER
);
/*
  The id is part of the index, not just the ORDER BY: results written by one
  setStatusBulk all share a timestamp, so created_on alone leaves their order
  undefined. Without the third column that tiebreak costs a temp B-tree on
  every history read.
*/
CREATE INDEX IF NOT EXISTS idx_results_test          ON results(test_id, created_on DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_results_source ON results(source, source_id);
/*
  The dashboard's activity feed, which reads the newest results in a project.
  Without this the planner scans every result in the database through
  idx_results_test and sorts the lot: measured at 10,000 tests and 5,000
  results, SCAN results USING INDEX idx_results_test plus USE TEMP B-TREE FOR
  ORDER BY, 1.9ms and growing with the table rather than with the page. With
  it the walk is newest-first and stops at the limit: 0.1ms, no temp B-tree.

  Ceiling: the walk is over all results, not one project's, so a dormant
  project whose last result is a million rows back pays for the distance. A
  per-project index is the upgrade, and it needs runs.project_id denormalised
  onto results to exist - not worth it until a profile asks for it.
*/
CREATE INDEX IF NOT EXISTS idx_results_recent        ON results(created_on DESC, id DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY,
  entity_type  TEXT NOT NULL CHECK (entity_type IN (${ATTACHMENT_ENTITY_VALUES})),
  entity_id    INTEGER NOT NULL,
  filename     TEXT NOT NULL,
  mime         TEXT,
  size         INTEGER,
  storage_path TEXT NOT NULL,
  created_on   INTEGER NOT NULL,
  source       TEXT,
  source_id    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attachments_entity        ON attachments(entity_type, entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_source ON attachments(source, source_id);

CREATE TABLE IF NOT EXISTS import_runs (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'running', 'failed', 'done')),
  started_on  INTEGER NOT NULL,
  finished_on INTEGER,
  cursor      TEXT,
  report      TEXT
);
CREATE INDEX IF NOT EXISTS idx_import_runs_state ON import_runs(state, started_on DESC);
/*
  idx_import_runs_state leads on state, so it cannot answer the list's
  ORDER BY started_on and every page sorted the whole table through USE TEMP
  B-TREE FOR ORDER BY - 820us a page over 5000 imports. With this, 78us and
  flat. The id tiebreak is there because imports started in the same second
  would otherwise come back in an undefined order.
*/
CREATE INDEX IF NOT EXISTS idx_import_runs_recent ON import_runs(started_on DESC, id DESC);
`;

export function openDb(file: string): Database.Database {
  const database = new Database(file);
  try {
    // Off by default in SQLite, and silently so: every cascade depends on it.
    database.pragma("foreign_keys = ON");

    // The stamp is read before anything else is applied. A database from
    // another build has to be refused untouched - creating its missing tables
    // first and complaining afterwards is the half-working this guard exists
    // to prevent.
    database.exec(VERSION_TABLE);
    const stamped = database
      .prepare("SELECT version FROM schema_version LIMIT 1")
      .get() as { version: number } | undefined;
    if (stamped && stamped.version !== SCHEMA_VERSION) {
      throw new Error(
        `Database schema is version ${stamped.version}, this build expects ` +
          `${SCHEMA_VERSION}. There is no migration path before the first ` +
          `release: delete ${file}* and start again.`,
      );
    }

    database.pragma("journal_mode = WAL");
    database.exec(SCHEMA);
    seedBuiltInStatuses(database);

    if (!stamped) {
      database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    }
    return database;
  } catch (error) {
    // Without this every request against a stale file leaks another handle
    // and its WAL lock, because getDb does not cache a failed open.
    database.close();
    throw error;
  }
}

/*
  System rows, not seed data: the five ids are part of the contract with
  TestRail, and tests and results carry foreign keys onto them. Upserted on the
  id so a corrected label or colour reaches an existing database, which no
  SCHEMA_VERSION bump would catch because the DDL does not change.
*/
function seedBuiltInStatuses(database: Database.Database): void {
  const insert = database.prepare(
    `INSERT INTO statuses (id, system_name, label, color, is_untested, is_final)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       system_name = excluded.system_name,
       label       = excluded.label,
       color       = excluded.color,
       is_untested = excluded.is_untested,
       is_final    = excluded.is_final`,
  );
  const seed = database.transaction(() => {
    for (const status of BUILT_IN_STATUSES) {
      insert.run(
        status.id,
        status.systemName,
        status.label,
        status.color,
        status.isUntested,
        status.isFinal,
      );
    }
  });
  seed();
}

// Next.js dev reloads the module graph on every edit; without this a new
// SQLite handle leaks per edit until the WAL lock starts failing.
const connectionCache = globalThis as unknown as { minitcmsDb?: Database.Database };

export function getDb(): Database.Database {
  if (!connectionCache.minitcmsDb) {
    connectionCache.minitcmsDb = openDb(process.env.SQLITE_FILE ?? "./data.db");
  }
  return connectionCache.minitcmsDb;
}

/*
  Who work can be handed to, and the names the run screens show instead of a
  bare user id. Inactive accounts are left out: assigning a test to a disabled
  account creates a queue nobody is watching.

  The column list is explicit because `SELECT *` here would put password_hash
  one careless Response.json away from the browser.

  EXPLAIN QUERY PLAN over 60 users, searched and unsearched:
  SCAN users USING INDEX idx_users_email - no temp B-tree, the ORDER BY rides
  the unique index the email lookup already needs. 0.1ms for a page of 25.
*/
export function listUsers(
  database: Database.Database,
  options: ListOptions = {},
): ListResult<AssignableUser> {
  const search = options.search?.trim() ? likePattern(options.search) : null;
  const where = `WHERE is_active = 1${
    search ? " AND (email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')" : ""
  }`;
  const filter = search ? [search, search] : [];
  const total = (
    database.prepare(`SELECT COUNT(*) AS total FROM users ${where}`).get(...filter) as {
      total: number;
    }
  ).total;
  const rows = database
    .prepare(
      `SELECT id, email, name, role FROM users ${where} ORDER BY email LIMIT ? OFFSET ?`,
    )
    .all(...filter, clampPageSize(options.limit), offsetFor(options.page, options.limit)) as AssignableUser[];
  return paged(rows, total, options);
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function countUsers(database: Database.Database): number {
  const row = database.prepare("SELECT COUNT(*) AS total FROM users").get() as { total: number };
  return row.total;
}

export function findUserByEmail(
  database: Database.Database,
  email: string,
): UserRow | undefined {
  return database
    .prepare(
      `SELECT id, email, name, role, is_active, password_hash, created_on
         FROM users
        WHERE email = ?`,
    )
    .get(normaliseEmail(email)) as UserRow | undefined;
}

export function createUser(
  database: Database.Database,
  user: { email: string; name?: string | null; role: UserRole; passwordHash: string | null },
): number {
  const result = database
    .prepare(
      `INSERT INTO users (email, name, role, password_hash, created_on)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      normaliseEmail(user.email),
      user.name ?? null,
      user.role,
      user.passwordHash,
      nowSeconds(),
    );
  return Number(result.lastInsertRowid);
}

export function insertSession(
  database: Database.Database,
  session: { tokenHash: string; userId: number; expiresOn: number; userAgent: string | null },
): void {
  database
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_on, expires_on, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      session.tokenHash,
      session.userId,
      nowSeconds(),
      session.expiresOn,
      session.userAgent,
    );
}

export function findSessionUser(
  database: Database.Database,
  tokenHash: string,
): SessionUser | undefined {
  const row = database
    .prepare(
      `SELECT users.id AS userId, users.email, users.name, users.role,
              sessions.expires_on AS expiresOn
         FROM sessions
         JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ?
          AND sessions.expires_on > ?
          AND users.is_active = 1`,
    )
    .get(tokenHash, nowSeconds()) as SessionUser | undefined;
  return row;
}

export function deleteSession(database: Database.Database, tokenHash: string): void {
  database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function deleteExpiredSessions(database: Database.Database): number {
  const result = database
    .prepare("DELETE FROM sessions WHERE expires_on <= ?")
    .run(nowSeconds());
  return result.changes;
}

export function recordLoginAttempt(database: Database.Database, identifier: string): void {
  database
    .prepare("INSERT INTO login_attempts (identifier, attempted_on) VALUES (?, ?)")
    .run(identifier, nowSeconds());
}

export function countLoginAttempts(
  database: Database.Database,
  identifier: string,
  windowSeconds: number,
): number {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS total FROM login_attempts WHERE identifier = ? AND attempted_on > ?",
    )
    .get(identifier, nowSeconds() - windowSeconds) as { total: number };
  return row.total;
}

export function deleteExpiredLoginAttempts(
  database: Database.Database,
  windowSeconds: number,
): number {
  const result = database
    .prepare("DELETE FROM login_attempts WHERE attempted_on <= ?")
    .run(nowSeconds() - windowSeconds);
  return result.changes;
}

export function clearLoginAttempts(database: Database.Database, identifier: string): void {
  database.prepare("DELETE FROM login_attempts WHERE identifier = ?").run(identifier);
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/* ------------------------------------------------------------------ *
 * API keys: the credential a CI job presents instead of a cookie
 * ------------------------------------------------------------------ */

export function insertApiKey(
  database: Database.Database,
  key: { userId: number; name: string; keyHash: string },
): number {
  const result = database
    .prepare("INSERT INTO api_keys (user_id, name, key_hash, created_on) VALUES (?, ?, ?, ?)")
    .run(key.userId, key.name, key.keyHash, nowSeconds());
  return Number(result.lastInsertRowid);
}

/*
  The key path's one lookup, and the mirror of findSessionUser: the role comes
  from the owner's row, so a key is never more than its owner, and a
  deactivated account's keys stop working the moment the account does.

  EXPLAIN QUERY PLAN over 500 keys and 50 users: SEARCH api_keys USING INDEX
  idx_api_keys_hash (key_hash=?), SEARCH users USING INTEGER PRIMARY KEY.
  0.014ms per call, and flat as the table grows - this runs on every single
  API request, so it had better not be a scan.
*/
export function findApiKeyUser(
  database: Database.Database,
  keyHash: string,
): SessionUser | undefined {
  return database
    .prepare(
      `SELECT users.id AS userId, users.email, users.name, users.role,
              NULL AS expiresOn, api_keys.id AS apiKeyId
         FROM api_keys
         JOIN users ON users.id = api_keys.user_id
        WHERE api_keys.key_hash = ?
          AND api_keys.revoked_on IS NULL
          AND users.is_active = 1`,
    )
    .get(keyHash) as SessionUser | undefined;
}

export const API_KEY_TOUCH_SECONDS = 60;

/*
  Coarse on purpose. This answers one question - is this key still in use, or
  can it be revoked - and a minute's resolution answers it. Writing on every
  request would mean a write per API read, which is what SQLite serialises on
  and exactly what the rate limiter exists to keep off the hot path.

  One UPDATE, no read first (AGENTS.md rule 17): two CI jobs sharing a key
  would otherwise race and one of the two timestamps would be lost.
*/
export function touchApiKey(database: Database.Database, id: number): void {
  const now = nowSeconds();
  database
    .prepare(
      `UPDATE api_keys SET last_used_on = ?
        WHERE id = ? AND (last_used_on IS NULL OR last_used_on < ?)`,
    )
    .run(now, id, now - API_KEY_TOUCH_SECONDS);
}

/*
  Keys as a human may see them: no key_hash in the column list, so the secret
  cannot reach a response body by somebody adding a Response.json later.

  EXPLAIN QUERY PLAN over 500 keys: SCAN api_keys, SEARCH users USING INTEGER
  PRIMARY KEY, and no temp B-tree - ORDER BY id DESC walks the rowid backwards
  and stops at the limit. 0.036ms for a page of 25. The scan is left alone: it
  is bounded by the page, and this table holds one row per CI job.
*/
export function listApiKeys(
  database: Database.Database,
  options: ListOptions & { userId?: number } = {},
): ListResult<ApiKeyRow> {
  const where = options.userId === undefined ? "" : "WHERE api_keys.user_id = ?";
  const filter = options.userId === undefined ? [] : [options.userId];
  const total = (
    database.prepare(`SELECT COUNT(*) AS total FROM api_keys ${where}`).get(...filter) as {
      total: number;
    }
  ).total;
  const rows = database
    .prepare(
      `SELECT api_keys.id, api_keys.user_id, users.email, api_keys.name,
              api_keys.created_on, api_keys.last_used_on, api_keys.revoked_on
         FROM api_keys
         JOIN users ON users.id = api_keys.user_id
         ${where}
        ORDER BY api_keys.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...filter, clampPageSize(options.limit), offsetFor(options.page, options.limit)) as ApiKeyRow[];
  return paged(rows, total, options);
}

// Revoking twice is not success: the second call tells the caller the key was
// already dead rather than implying it just stopped it.
export function revokeApiKey(database: Database.Database, id: number): void {
  const result = database
    .prepare("UPDATE api_keys SET revoked_on = ? WHERE id = ? AND revoked_on IS NULL")
    .run(nowSeconds(), id);
  if (result.changes === 0) {
    if (!database.prepare("SELECT 1 FROM api_keys WHERE id = ?").get(id)) {
      throw new NotFoundError(`No API key with id ${id}`);
    }
    throw new ConflictError(`API key ${id} is already revoked`);
  }
}

/* ------------------------------------------------------------------ *
 * Phase 2: projects, suites, sections, cases, custom field definitions
 * ------------------------------------------------------------------ */

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

export type ListOptions = { search?: string | null; limit?: unknown; page?: unknown };

/*
  LIKE treats % and _ as wildcards, so a search for "50%" would match far more
  than the user asked for. Escaped with a backslash, declared by ESCAPE on
  every LIKE that uses this.
*/
function likePattern(search: string): string {
  const escaped = search.trim().replace(/[\\%_]/g, (character) => `\\${character}`);
  return `%${escaped}%`;
}

function paged<Row>(
  rows: Row[],
  total: number,
  options: ListOptions,
): ListResult<Row> {
  return { rows, total, page: clampPage(options.page), limit: clampPageSize(options.limit) };
}

// Writes reject an unknown id rather than silently changing nothing, so a
// caller never has to compare `changes` to know whether it worked.
function assertChanged(changes: number, what: string, id: number): void {
  if (changes === 0) throw new NotFoundError(`No ${what} with id ${id}`);
}

export function listProjects(
  database: Database.Database,
  options: ListOptions = {},
): ListResult<ProjectRow> {
  const search = options.search?.trim() ? likePattern(options.search) : null;
  const where = search ? "WHERE name LIKE ? ESCAPE '\\'" : "";
  const filter = search ? [search] : [];
  const total = (
    database.prepare(`SELECT COUNT(*) AS total FROM projects ${where}`).get(...filter) as {
      total: number;
    }
  ).total;
  const rows = database
    .prepare(
      `SELECT id, name, announcement, suite_mode, is_completed, created_on, source, source_id
         FROM projects ${where}
        ORDER BY is_completed, name
        LIMIT ? OFFSET ?`,
    )
    .all(...filter, clampPageSize(options.limit), offsetFor(options.page, options.limit)) as ProjectRow[];
  return paged(rows, total, options);
}

export function getProject(database: Database.Database, id: number): ProjectRow | undefined {
  return database.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
}

export function createProject(
  database: Database.Database,
  project: { name: string; announcement?: string | null; suiteMode?: SuiteMode },
): number {
  const result = database
    .prepare(
      `INSERT INTO projects (name, announcement, suite_mode, created_on)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      project.name,
      project.announcement ?? null,
      project.suiteMode ?? SUITE_MODE.single,
      nowSeconds(),
    );
  return Number(result.lastInsertRowid);
}

export function updateProject(
  database: Database.Database,
  id: number,
  patch: { name?: string; announcement?: string | null; isCompleted?: boolean },
): void {
  const result = database
    .prepare(
      `UPDATE projects
          SET name         = COALESCE(?, name),
              announcement = CASE WHEN ? THEN ? ELSE announcement END,
              is_completed = COALESCE(?, is_completed)
        WHERE id = ?`,
    )
    .run(
      patch.name ?? null,
      patch.announcement === undefined ? 0 : 1,
      patch.announcement ?? null,
      patch.isCompleted === undefined ? null : Number(patch.isCompleted),
      id,
    );
  assertChanged(result.changes, "project", id);
}

export function listSuites(
  database: Database.Database,
  projectId: number,
  options: ListOptions = {},
): ListResult<SuiteRow> {
  const search = options.search?.trim() ? likePattern(options.search) : null;
  const filter = search ? [projectId, search] : [projectId];
  const where = `WHERE project_id = ?${search ? " AND name LIKE ? ESCAPE '\\'" : ""}`;
  const total = (
    database.prepare(`SELECT COUNT(*) AS total FROM suites ${where}`).get(...filter) as {
      total: number;
    }
  ).total;
  const rows = database
    .prepare(
      `SELECT id, project_id, name, description, is_baseline, baseline_of, source, source_id
         FROM suites ${where}
        ORDER BY is_baseline, name
        LIMIT ? OFFSET ?`,
    )
    .all(...filter, clampPageSize(options.limit), offsetFor(options.page, options.limit)) as SuiteRow[];
  return paged(rows, total, options);
}

export function getSuite(database: Database.Database, id: number): SuiteRow | undefined {
  return database.prepare("SELECT * FROM suites WHERE id = ?").get(id) as SuiteRow | undefined;
}

export function createSuite(
  database: Database.Database,
  suite: { projectId: number; name: string; description?: string | null },
): number {
  const result = database
    .prepare("INSERT INTO suites (project_id, name, description) VALUES (?, ?, ?)")
    .run(suite.projectId, suite.name, suite.description ?? null);
  return Number(result.lastInsertRowid);
}

export function updateSuite(
  database: Database.Database,
  id: number,
  patch: { name?: string; description?: string | null },
): void {
  const result = database
    .prepare(
      `UPDATE suites
          SET name        = COALESCE(?, name),
              description = CASE WHEN ? THEN ? ELSE description END
        WHERE id = ?`,
    )
    .run(patch.name ?? null, patch.description === undefined ? 0 : 1, patch.description ?? null, id);
  assertChanged(result.changes, "suite", id);
}


/*
  The whole tree in one query, in render order. `sort_path` is built as the CTE
  walks down so the result comes back depth-first with siblings in
  display_order - the caller indents by `depth` and never sorts again.

  The level bound is not decoration: a parent_id cycle would spin this CTE
  forever and take the process with it. moveSection rejects cycles, so the
  bound should never fire; it is there for the day something else writes a
  parent_id.
*/
export function sectionTree(database: Database.Database, suiteId: number): SectionTreeRow[] {
  return database
    .prepare(
      `WITH RECURSIVE tree AS (
         SELECT id, parent_id, depth, display_order, name, description, 0 AS level,
                printf('%08d.%08d', display_order, id) AS sort_path
           FROM sections
          WHERE suite_id = ? AND parent_id IS NULL
          UNION ALL
         SELECT child.id, child.parent_id, child.depth, child.display_order, child.name,
                child.description, tree.level + 1,
                tree.sort_path || '/' || printf('%08d.%08d', child.display_order, child.id)
           FROM sections child
           JOIN tree ON child.parent_id = tree.id
          WHERE tree.level + 1 < ?
       )
       SELECT tree.id, tree.parent_id, tree.depth, tree.display_order, tree.name, tree.description,
              (SELECT COUNT(*) FROM cases
                WHERE cases.section_id = tree.id AND cases.is_deleted = 0) AS case_count
         FROM tree
        ORDER BY tree.sort_path`,
    )
    .all(suiteId, MAX_SECTION_LEVELS) as SectionTreeRow[];
}

// A section and everything under it, used by both the cycle check and the
// depth rewrite in moveSection.
function subtree(database: Database.Database, sectionId: number): { id: number; depth: number }[] {
  return database
    .prepare(
      `WITH RECURSIVE branch AS (
         SELECT id, depth, 0 AS level FROM sections WHERE id = ?
          UNION ALL
         SELECT child.id, child.depth, branch.level + 1
           FROM sections child
           JOIN branch ON child.parent_id = branch.id
          WHERE branch.level + 1 < ?
       )
       SELECT id, depth FROM branch`,
    )
    .all(sectionId, MAX_SECTION_LEVELS) as { id: number; depth: number }[];
}

function requireSection(database: Database.Database, id: number): SectionRow {
  const section = database.prepare("SELECT * FROM sections WHERE id = ?").get(id) as
    | SectionRow
    | undefined;
  if (!section) throw new NotFoundError(`No section with id ${id}`);
  return section;
}

function nextDisplayOrder(
  database: Database.Database,
  suiteId: number,
  parentId: number | null,
): number {
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(display_order), -1) + 1 AS next
         FROM sections
        WHERE suite_id = ? AND parent_id IS ?`,
    )
    .get(suiteId, parentId) as { next: number };
  return row.next;
}

export function createSection(
  database: Database.Database,
  section: {
    suiteId: number;
    parentId?: number | null;
    name: string;
    description?: string | null;
    displayOrder?: number;
  },
): number {
  const parentId = section.parentId ?? null;
  let depth = 0;
  if (parentId !== null) {
    const parent = requireSection(database, parentId);
    if (parent.suite_id !== section.suiteId) {
      throw new ConflictError(`Section ${parentId} is in another suite`);
    }
    depth = parent.depth + 1;
  }
  if (depth >= MAX_SECTION_LEVELS) {
    throw new ConflictError(
      `Sections nest ${MAX_SECTION_LEVELS} levels deep at most; this one would be level ${depth + 1}`,
    );
  }
  const result = database
    .prepare(
      `INSERT INTO sections (suite_id, parent_id, depth, display_order, name, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      section.suiteId,
      parentId,
      depth,
      section.displayOrder ?? nextDisplayOrder(database, section.suiteId, parentId),
      section.name,
      section.description ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function updateSection(
  database: Database.Database,
  id: number,
  patch: { name?: string; description?: string | null },
): void {
  const result = database
    .prepare(
      `UPDATE sections
          SET name        = COALESCE(?, name),
              description = CASE WHEN ? THEN ? ELSE description END
        WHERE id = ?`,
    )
    .run(patch.name ?? null, patch.description === undefined ? 0 : 1, patch.description ?? null, id);
  assertChanged(result.changes, "section", id);
}

/*
  Rename and move in one transaction, because the route offers them as one
  action. Run separately, a move that is rejected after the rename succeeded
  leaves the section renamed and still in the wrong place - a half-applied
  edit the caller never asked for and cannot see from the error.
*/
export function editSection(
  database: Database.Database,
  id: number,
  patch: {
    name?: string;
    description?: string | null;
    parentId?: number | null;
    displayOrder?: number;
  },
): void {
  const edit = database.transaction(() => {
    if (patch.name !== undefined || patch.description !== undefined) {
      updateSection(database, id, { name: patch.name, description: patch.description });
    }
    if (patch.parentId !== undefined) {
      moveSection(database, id, patch.parentId, patch.displayOrder);
    }
  });
  edit();
}

/*
  Moving a section carries its whole subtree, so the depth of every descendant
  shifts by the same delta - one UPDATE over the subtree, not a walk. The two
  rejections are the ones that corrupt a tree rather than merely annoy: a move
  into own descendant orphans the branch from the root, and a move that pushes
  a deep subtree past the depth cap fails the CHECK halfway through.
*/
export function moveSection(
  database: Database.Database,
  sectionId: number,
  newParentId: number | null,
  newOrder?: number,
): void {
  const move = database.transaction(() => {
    const section = requireSection(database, sectionId);
    if (newParentId === sectionId) {
      throw new ConflictError("A section cannot be its own parent");
    }

    let newDepth = 0;
    if (newParentId !== null) {
      const parent = requireSection(database, newParentId);
      if (parent.suite_id !== section.suite_id) {
        throw new ConflictError(`Section ${newParentId} is in another suite`);
      }
      newDepth = parent.depth + 1;
    }

    const branch = subtree(database, sectionId);
    if (newParentId !== null && branch.some((node) => node.id === newParentId)) {
      throw new ConflictError(`Section ${newParentId} is inside section ${sectionId}`);
    }

    const delta = newDepth - section.depth;
    const deepest = Math.max(...branch.map((node) => node.depth));
    if (deepest + delta >= MAX_SECTION_LEVELS) {
      throw new ConflictError(
        `That move would nest sections ${deepest + delta + 1} levels deep; the cap is ${MAX_SECTION_LEVELS}`,
      );
    }

    if (delta !== 0) {
      // The subtree is re-walked in SQL rather than bound as an id list: a
      // wide suite can hold more sections than SQLite will take parameters,
      // and this way the cap never enters into it.
      database
        .prepare(
          `UPDATE sections SET depth = depth + ?
            WHERE id IN (
              WITH RECURSIVE branch AS (
                SELECT id, 0 AS level FROM sections WHERE id = ?
                 UNION ALL
                SELECT child.id, branch.level + 1
                  FROM sections child
                  JOIN branch ON child.parent_id = branch.id
                 WHERE branch.level + 1 < ?
              )
              SELECT id FROM branch
            )`,
        )
        .run(delta, sectionId, MAX_SECTION_LEVELS);
    }
    database
      .prepare("UPDATE sections SET parent_id = ?, display_order = ? WHERE id = ?")
      .run(
        newParentId,
        newOrder ?? nextDisplayOrder(database, section.suite_id, newParentId),
        sectionId,
      );
  });
  move();
}

export function listCaseFields(database: Database.Database): CaseFieldRow[] {
  return database
    .prepare("SELECT * FROM case_fields ORDER BY label")
    .all() as CaseFieldRow[];
}

/*
  Keyed on system_name, not on an id: a CSV import can only infer
  `type = 'text'` from a column header, and a later API import has to be able
  to correct that definition in place rather than create a second one.
*/
export function upsertCaseField(
  database: Database.Database,
  field: {
    systemName: string;
    label: string;
    type: string;
    isGlobal?: boolean;
    configs?: string | null;
    source?: string | null;
    sourceId?: number | null;
  },
): UpsertResult {
  const before = database
    .prepare("SELECT id, label, type, is_global, configs FROM case_fields WHERE system_name = ?")
    .get(field.systemName) as
    | { id: number; label: string; type: string; is_global: number; configs: string | null }
    | undefined;

  const isGlobal = field.isGlobal === false ? 0 : 1;
  const configs = field.configs ?? null;

  database
    .prepare(
      `INSERT INTO case_fields (system_name, label, type, is_global, configs, source, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(system_name) DO UPDATE SET
         label     = excluded.label,
         type      = excluded.type,
         is_global = excluded.is_global,
         configs   = excluded.configs`,
    )
    .run(
      field.systemName,
      field.label,
      field.type,
      isGlobal,
      configs,
      field.source ?? null,
      field.sourceId ?? null,
    );

  if (!before) {
    /*
      Read the id back rather than trusting lastInsertRowid: this function
      has two branches and on the DO UPDATE one that value is left over from
      whatever this connection inserted last, in whatever table.
    */
    const inserted = database
      .prepare("SELECT id FROM case_fields WHERE system_name = ?")
      .get(field.systemName) as { id: number };
    return { id: inserted.id, action: "inserted" };
  }

  /*
    The import reports "second run changed nothing", which only means
    something if unchanged is counted apart from updated - so the comparison
    happens here rather than being approximated by the caller.
  */
  const changed =
    before.label !== field.label ||
    before.type !== field.type ||
    before.is_global !== isGlobal ||
    before.configs !== configs;
  return { id: before.id, action: changed ? "updated" : "unchanged" };
}

export type CaseFilter = ListOptions & {
  sectionId?: number | null;
  typeId?: number | null;
  priorityId?: number | null;
};

export function listCases(
  database: Database.Database,
  suiteId: number,
  filter: CaseFilter = {},
): ListResult<CaseRow> {
  const conditions = ["suite_id = ?", "is_deleted = 0"];
  const values: unknown[] = [suiteId];

  if (filter.sectionId !== undefined && filter.sectionId !== null) {
    conditions.push("section_id = ?");
    values.push(filter.sectionId);
  }
  if (filter.typeId !== undefined && filter.typeId !== null) {
    conditions.push("type_id = ?");
    values.push(filter.typeId);
  }
  if (filter.priorityId !== undefined && filter.priorityId !== null) {
    conditions.push("priority_id = ?");
    values.push(filter.priorityId);
  }
  if (filter.search?.trim()) {
    conditions.push("(title LIKE ? ESCAPE '\\' OR refs LIKE ? ESCAPE '\\')");
    const pattern = likePattern(filter.search);
    values.push(pattern, pattern);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const total = (
    database.prepare(`SELECT COUNT(*) AS total FROM cases ${where}`).get(...values) as {
      total: number;
    }
  ).total;
  const rows = database
    .prepare(`SELECT * FROM cases ${where} ORDER BY section_id, id LIMIT ? OFFSET ?`)
    .all(...values, clampPageSize(filter.limit), offsetFor(filter.page, filter.limit)) as CaseRow[];
  return paged(rows, total, filter);
}

export function getCase(database: Database.Database, id: number): CaseRow | undefined {
  return database
    .prepare("SELECT * FROM cases WHERE id = ? AND is_deleted = 0")
    .get(id) as CaseRow | undefined;
}

type CaseInput = {
  suiteId: number;
  sectionId?: number | null;
  title: string;
  templateId?: number;
  typeId?: number | null;
  priorityId?: number | null;
  refs?: string | null;
  estimate?: string | null;
  milestoneId?: number | null;
  custom?: Record<string, unknown>;
  createdBy?: number | null;
  // The TestRail import keeps a value whose field it has no definition for
  // and reports it (AGENTS.md rule 4); the API rejects it as a typo.
  allowUnknownCustom?: boolean;
};

function serialiseCustom(
  database: Database.Database,
  values: Record<string, unknown> | undefined,
  allowUnknown: boolean,
): string | null {
  if (!values || Object.keys(values).length === 0) return null;
  const { custom, unknownKeys } = validateCustom(listCaseFields(database), values);
  if (unknownKeys.length > 0 && !allowUnknown) {
    throw new CaseFieldError(`No such custom field: ${unknownKeys.join(", ")}`);
  }
  return JSON.stringify(custom);
}

function assertSectionInSuite(
  database: Database.Database,
  sectionId: number | null | undefined,
  suiteId: number,
): void {
  if (sectionId === null || sectionId === undefined) return;
  const section = requireSection(database, sectionId);
  if (section.suite_id !== suiteId) {
    throw new ConflictError(`Section ${sectionId} is in another suite`);
  }
}

export function createCase(database: Database.Database, input: CaseInput): number {
  assertSectionInSuite(database, input.sectionId, input.suiteId);
  const custom = serialiseCustom(database, input.custom, input.allowUnknownCustom === true);
  const timestamp = nowSeconds();
  const result = database
    .prepare(
      `INSERT INTO cases (section_id, suite_id, title, template_id, type_id, priority_id,
                          refs, estimate, milestone_id, custom,
                          created_by, created_on, updated_by, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sectionId ?? null,
      input.suiteId,
      input.title,
      input.templateId ?? 1,
      input.typeId ?? null,
      input.priorityId ?? null,
      input.refs ?? null,
      input.estimate ?? null,
      input.milestoneId ?? null,
      custom,
      input.createdBy ?? null,
      timestamp,
      input.createdBy ?? null,
      timestamp,
    );
  return Number(result.lastInsertRowid);
}

export type CasePatch = {
  sectionId?: number | null;
  title?: string;
  templateId?: number;
  typeId?: number | null;
  priorityId?: number | null;
  refs?: string | null;
  estimate?: string | null;
  milestoneId?: number | null;
  custom?: Record<string, unknown>;
  allowUnknownCustom?: boolean;
};

/*
  `custom` replaces the whole bag rather than merging into it. Merging would
  make deleting a value impossible through this API, and a half-updated bag is
  harder to reason about than one the caller sent complete.
*/
export function updateCase(
  database: Database.Database,
  id: number,
  patch: CasePatch,
  updatedBy: number | null,
): void {
  const existing = getCase(database, id);
  if (!existing) throw new NotFoundError(`No case with id ${id}`);
  if (patch.sectionId !== undefined) {
    assertSectionInSuite(database, patch.sectionId, existing.suite_id);
  }
  /*
    An untouched `custom` is left alone by the UPDATE rather than read here
    and written back. Writing it back would make a concurrent edit to another
    field quietly revert whatever that edit did to the bag, and this function
    cannot hold a read lock across its own statement.
  */
  const custom =
    patch.custom === undefined
      ? null
      : serialiseCustom(database, patch.custom, patch.allowUnknownCustom === true);

  database
    .prepare(
      `UPDATE cases
          SET section_id   = CASE WHEN ? THEN ? ELSE section_id END,
              title        = COALESCE(?, title),
              template_id  = COALESCE(?, template_id),
              type_id      = CASE WHEN ? THEN ? ELSE type_id END,
              priority_id  = CASE WHEN ? THEN ? ELSE priority_id END,
              refs         = CASE WHEN ? THEN ? ELSE refs END,
              estimate     = CASE WHEN ? THEN ? ELSE estimate END,
              milestone_id = CASE WHEN ? THEN ? ELSE milestone_id END,
              custom       = CASE WHEN ? THEN ? ELSE custom END,
              updated_by   = ?,
              updated_on   = ?
        WHERE id = ?`,
    )
    .run(
      patch.sectionId === undefined ? 0 : 1,
      patch.sectionId ?? null,
      patch.title ?? null,
      patch.templateId ?? null,
      patch.typeId === undefined ? 0 : 1,
      patch.typeId ?? null,
      patch.priorityId === undefined ? 0 : 1,
      patch.priorityId ?? null,
      patch.refs === undefined ? 0 : 1,
      patch.refs ?? null,
      patch.estimate === undefined ? 0 : 1,
      patch.estimate ?? null,
      patch.milestoneId === undefined ? 0 : 1,
      patch.milestoneId ?? null,
      patch.custom === undefined ? 0 : 1,
      custom,
      updatedBy,
      nowSeconds(),
      id,
    );
}

// Soft: a hard delete would take the run history with it through
// tests.case_id, and a test that lost its case is still a thing that happened.
export function deleteCase(
  database: Database.Database,
  id: number,
  deletedBy: number | null,
): void {
  const result = database
    .prepare(
      "UPDATE cases SET is_deleted = 1, updated_by = ?, updated_on = ? WHERE id = ? AND is_deleted = 0",
    )
    .run(deletedBy, nowSeconds(), id);
  assertChanged(result.changes, "case", id);
}

// SQLite's default parameter ceiling is 999, so an IN list of ids has to be
// chunked whatever the caller hands over. Phase 4 hands over tens of thousands.
const BULK_CHUNK = 500;

/*
  An upper bound on one request, separate from the chunk size. SQLite will
  take 32766 parameters, so chunking alone does not stop a caller sending a
  million ids and holding a write transaction open while they are applied.
  Phase 4 imports in batches of its own and never needs more than this.
*/
export const MAX_BULK_IDS = 10_000;

function assertBulkSize(caseIds: readonly number[]): void {
  if (caseIds.length > MAX_BULK_IDS) {
    throw new ConflictError(`At most ${MAX_BULK_IDS} ids in one call, got ${caseIds.length}`);
  }
}

function chunked<Item>(items: readonly Item[]): Item[][] {
  const chunks: Item[][] = [];
  for (let start = 0; start < items.length; start += BULK_CHUNK) {
    chunks.push(items.slice(start, start + BULK_CHUNK));
  }
  return chunks;
}

export function bulkMoveCases(
  database: Database.Database,
  caseIds: readonly number[],
  sectionId: number,
  updatedBy: number | null,
): number {
  assertBulkSize(caseIds);
  const section = requireSection(database, sectionId);
  const move = database.transaction(() => {
    let moved = 0;
    for (const chunk of chunked(caseIds)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const result = database
        .prepare(
          `UPDATE cases
              SET section_id = ?, updated_by = ?, updated_on = ?
            WHERE id IN (${placeholders}) AND suite_id = ? AND is_deleted = 0`,
        )
        .run(sectionId, updatedBy, nowSeconds(), ...chunk, section.suite_id);
      moved += result.changes;
    }
    return moved;
  });
  return move();
}

export function bulkUpdateCases(
  database: Database.Database,
  caseIds: readonly number[],
  patch: { typeId?: number | null; priorityId?: number | null; milestoneId?: number | null },
  updatedBy: number | null,
): number {
  assertBulkSize(caseIds);
  const update = database.transaction(() => {
    let changed = 0;
    for (const chunk of chunked(caseIds)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const result = database
        .prepare(
          `UPDATE cases
              SET type_id      = CASE WHEN ? THEN ? ELSE type_id END,
                  priority_id  = CASE WHEN ? THEN ? ELSE priority_id END,
                  milestone_id = CASE WHEN ? THEN ? ELSE milestone_id END,
                  updated_by   = ?,
                  updated_on   = ?
            WHERE id IN (${placeholders}) AND is_deleted = 0`,
        )
        .run(
          patch.typeId === undefined ? 0 : 1,
          patch.typeId ?? null,
          patch.priorityId === undefined ? 0 : 1,
          patch.priorityId ?? null,
          patch.milestoneId === undefined ? 0 : 1,
          patch.milestoneId ?? null,
          updatedBy,
          nowSeconds(),
          ...chunk,
        );
      changed += result.changes;
    }
    return changed;
  });
  return update();
}

/* ------------------------------------------------------------------ *
 * Phase 3: milestones, plans, runs, tests, append-only results
 * ------------------------------------------------------------------ */

export function listStatuses(database: Database.Database): StatusRow[] {
  return database
    .prepare("SELECT id, system_name, label, color, is_untested, is_final FROM statuses ORDER BY id")
    .all() as StatusRow[];
}

export function listMilestones(
  database: Database.Database,
  projectId: number,
  options: ListOptions = {},
): ListResult<MilestoneRow> {
  const total = (
    database
      .prepare("SELECT COUNT(*) AS total FROM milestones WHERE project_id = ?")
      .get(projectId) as { total: number }
  ).total;
  const rows = database
    .prepare(
      `SELECT * FROM milestones WHERE project_id = ?
        ORDER BY is_completed, COALESCE(due_on, 1 << 40), id
        LIMIT ? OFFSET ?`,
    )
    .all(projectId, clampPageSize(options.limit), offsetFor(options.page, options.limit)) as MilestoneRow[];
  return paged(rows, total, options);
}

export function getMilestone(database: Database.Database, id: number): MilestoneRow | undefined {
  return database.prepare("SELECT * FROM milestones WHERE id = ?").get(id) as
    | MilestoneRow
    | undefined;
}

export function createMilestone(
  database: Database.Database,
  milestone: {
    projectId: number;
    parentId?: number | null;
    name: string;
    description?: string | null;
    dueOn?: number | null;
    startedOn?: number | null;
  },
): number {
  if (milestone.parentId !== undefined && milestone.parentId !== null) {
    const parent = getMilestone(database, milestone.parentId);
    if (!parent) throw new NotFoundError(`No milestone with id ${milestone.parentId}`);
    if (parent.project_id !== milestone.projectId) {
      throw new ConflictError(`Milestone ${milestone.parentId} is in another project`);
    }
  }
  const result = database
    .prepare(
      `INSERT INTO milestones (project_id, parent_id, name, description, due_on, started_on)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      milestone.projectId,
      milestone.parentId ?? null,
      milestone.name,
      milestone.description ?? null,
      milestone.dueOn ?? null,
      milestone.startedOn ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function updateMilestone(
  database: Database.Database,
  id: number,
  patch: {
    name?: string;
    description?: string | null;
    dueOn?: number | null;
    startedOn?: number | null;
    isCompleted?: boolean;
  },
): void {
  const result = database
    .prepare(
      `UPDATE milestones
          SET name         = COALESCE(?, name),
              description  = CASE WHEN ? THEN ? ELSE description END,
              due_on       = CASE WHEN ? THEN ? ELSE due_on END,
              started_on   = CASE WHEN ? THEN ? ELSE started_on END,
              is_completed = COALESCE(?, is_completed)
        WHERE id = ?`,
    )
    .run(
      patch.name ?? null,
      patch.description === undefined ? 0 : 1,
      patch.description ?? null,
      patch.dueOn === undefined ? 0 : 1,
      patch.dueOn ?? null,
      patch.startedOn === undefined ? 0 : 1,
      patch.startedOn ?? null,
      patch.isCompleted === undefined ? null : Number(patch.isCompleted),
      id,
    );
  assertChanged(result.changes, "milestone", id);
}

export function listPlans(
  database: Database.Database,
  projectId: number,
  options: ListOptions = {},
): ListResult<PlanRow> {
  const total = (
    database.prepare("SELECT COUNT(*) AS total FROM plans WHERE project_id = ?").get(projectId) as {
      total: number;
    }
  ).total;
  const rows = database
    .prepare(
      `SELECT * FROM plans WHERE project_id = ?
        ORDER BY is_completed, created_on DESC, id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(projectId, clampPageSize(options.limit), offsetFor(options.page, options.limit)) as PlanRow[];
  return paged(rows, total, options);
}

export function getPlan(database: Database.Database, id: number): PlanRow | undefined {
  return database.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined;
}

function assertMilestoneInProject(
  database: Database.Database,
  milestoneId: number,
  projectId: number,
): void {
  const milestone = getMilestone(database, milestoneId);
  if (!milestone) throw new NotFoundError(`No milestone with id ${milestoneId}`);
  if (milestone.project_id !== projectId) {
    throw new ConflictError(`Milestone ${milestoneId} is in another project`);
  }
}

export function createPlan(
  database: Database.Database,
  plan: {
    projectId: number;
    name: string;
    description?: string | null;
    milestoneId?: number | null;
  },
): number {
  if (plan.milestoneId !== undefined && plan.milestoneId !== null) {
    assertMilestoneInProject(database, plan.milestoneId, plan.projectId);
  }
  const result = database
    .prepare(
      `INSERT INTO plans (project_id, name, description, milestone_id, created_on)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(plan.projectId, plan.name, plan.description ?? null, plan.milestoneId ?? null, nowSeconds());
  return Number(result.lastInsertRowid);
}

export function updatePlan(
  database: Database.Database,
  id: number,
  patch: {
    name?: string;
    description?: string | null;
    milestoneId?: number | null;
    isCompleted?: boolean;
  },
): void {
  const result = database
    .prepare(
      `UPDATE plans
          SET name         = COALESCE(?, name),
              description  = CASE WHEN ? THEN ? ELSE description END,
              milestone_id = CASE WHEN ? THEN ? ELSE milestone_id END,
              is_completed = COALESCE(?, is_completed)
        WHERE id = ?`,
    )
    .run(
      patch.name ?? null,
      patch.description === undefined ? 0 : 1,
      patch.description ?? null,
      patch.milestoneId === undefined ? 0 : 1,
      patch.milestoneId ?? null,
      patch.isCompleted === undefined ? null : Number(patch.isCompleted),
      id,
    );
  assertChanged(result.changes, "plan", id);
}

export type RunFilter = ListOptions & {
  projectId: number;
  planId?: number | null;
  isCompleted?: boolean;
};

export function listRuns(
  database: Database.Database,
  filter: RunFilter,
): ListResult<RunRow> {
  const conditions = ["project_id = ?"];
  const values: unknown[] = [filter.projectId];
  if (filter.planId !== undefined && filter.planId !== null) {
    conditions.push("plan_id = ?");
    values.push(filter.planId);
  }
  // Asked for by the dashboard, which wants a page of open runs rather than a
  // page of runs it then has to sift in the browser.
  if (filter.isCompleted !== undefined) {
    conditions.push("is_completed = ?");
    values.push(filter.isCompleted ? 1 : 0);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;
  const total = (
    database.prepare(`SELECT COUNT(*) AS total FROM runs ${where}`).get(...values) as {
      total: number;
    }
  ).total;
  /*
    Open runs first: a closed run is history, an open one is somebody's
    afternoon. This ORDER BY does sort rather than read an index, and that is
    left alone on purpose - a project holds hundreds of runs, not hundreds of
    thousands, and the sort measured 0.2ms. An index here would cost every
    run insert to save nothing anyone can perceive.

    With the is_completed filter the plan is SEARCH runs USING INDEX
    idx_runs_project plus USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY,
    measured over 300 runs and 60,000 tests: 0.8ms for a page of 25 with their
    status bars. Same conclusion - the sort is over one project's runs.
  */
  const rows = database
    .prepare(`SELECT * FROM runs ${where} ORDER BY is_completed, created_on DESC, id DESC
              LIMIT ? OFFSET ?`)
    .all(...values, clampPageSize(filter.limit), offsetFor(filter.page, filter.limit)) as RunRow[];
  return paged(rows, total, filter);
}

export type RunWithProgress = RunRow & { progress: RunProgress };

/*
  The run list with the numbers its stacked bars are drawn from: two queries
  for the page, not one per row. A list that fetched a summary per run would
  be 25 round trips to paint one screen, and the rollup rule is the same here
  as everywhere - counted in SQL, never by iterating fetched tests.
*/
export function listRunsWithProgress(
  database: Database.Database,
  filter: RunFilter,
): ListResult<RunWithProgress> {
  const page = listRuns(database, filter);
  if (page.rows.length === 0) return { ...page, rows: [] };
  const statuses = listStatuses(database);
  const counts = runSummaries(
    database,
    page.rows.map((run) => run.id),
  );
  return {
    ...page,
    rows: page.rows.map((run) => ({
      ...run,
      progress: runProgress(counts.get(run.id) ?? [], statuses),
    })),
  };
}

/*
  One GROUP BY for a page of runs. Chunked like every other id list even
  though a page caps at 100: the bound belongs to the function, not to the
  caller that happens to respect it today.

  EXPLAIN QUERY PLAN over 40 runs holding 80,000 tests:
  SEARCH tests USING COVERING INDEX idx_tests_run (run_id=?) - no temp B-tree,
  that index carries both grouped columns. A page of 25 runs covering 50,000
  of those tests costs 2.5ms end to end, bars included.
*/
function runSummaries(
  database: Database.Database,
  runIds: readonly number[],
): Map<number, StatusCount[]> {
  const byRun = new Map<number, StatusCount[]>();
  for (const chunk of chunked(runIds)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = database
      .prepare(
        `SELECT run_id, status_id, COUNT(*) AS total
           FROM tests
          WHERE run_id IN (${placeholders})
          GROUP BY run_id, status_id`,
      )
      .all(...chunk) as (StatusCount & { run_id: number })[];
    for (const row of rows) {
      const counts = byRun.get(row.run_id) ?? [];
      counts.push({ status_id: row.status_id, total: row.total });
      byRun.set(row.run_id, counts);
    }
  }
  return byRun;
}

export function getRun(database: Database.Database, id: number): RunRow | undefined {
  return database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
}

/*
  A run is a snapshot, not a view. The case set is resolved once, here, and
  every test keeps its own copy of the title - so editing or deleting a case
  afterwards never rewrites what a past run said it covered.

  The tests are inserted by INSERT ... SELECT rather than a loop in
  TypeScript: include_all over a 100k-case suite is one statement either way,
  and the loop version is the one that takes a minute.
*/
export function createRun(
  database: Database.Database,
  run: {
    projectId: number;
    suiteId: number;
    name: string;
    description?: string | null;
    config?: string | null;
    planId?: number | null;
    milestoneId?: number | null;
    includeAll?: boolean;
    caseIds?: readonly number[];
    assignedTo?: number | null;
  },
): number {
  // Contradictory input is refused rather than resolved. Picking a winner
  // between includeAll and an explicit case list means half of the callers
  // who send both get the run they did not ask for, and never find out.
  if (run.includeAll === true && run.caseIds !== undefined) {
    throw new ConflictError("Send either includeAll or caseIds, not both");
  }
  const includeAll = run.includeAll !== false && run.caseIds === undefined;
  if (!includeAll && (run.caseIds === undefined || run.caseIds.length === 0)) {
    throw new ConflictError("A run needs either includeAll or a non-empty caseIds");
  }
  if (run.caseIds && run.caseIds.length > MAX_BULK_IDS) {
    throw new ConflictError(`At most ${MAX_BULK_IDS} cases in one run creation`);
  }

  const suite = getSuite(database, run.suiteId);
  if (!suite) throw new NotFoundError(`No suite with id ${run.suiteId}`);
  if (suite.project_id !== run.projectId) {
    throw new ConflictError(`Suite ${run.suiteId} is in another project`);
  }
  if (run.milestoneId !== undefined && run.milestoneId !== null) {
    assertMilestoneInProject(database, run.milestoneId, run.projectId);
  }

  const create = database.transaction(() => {
    const inserted = database
      .prepare(
        `INSERT INTO runs (project_id, suite_id, plan_id, milestone_id, name, description,
                           config, include_all, created_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.projectId,
        run.suiteId,
        run.planId ?? null,
        run.milestoneId ?? null,
        run.name,
        run.description ?? null,
        run.config ?? null,
        Number(includeAll),
        nowSeconds(),
      );
    const runId = Number(inserted.lastInsertRowid);
    const assignedTo = run.assignedTo ?? null;

    if (includeAll) {
      database
        .prepare(
          `INSERT INTO tests (run_id, case_id, title_snapshot, assigned_to)
           SELECT ?, id, title, ? FROM cases WHERE suite_id = ? AND is_deleted = 0`,
        )
        .run(runId, assignedTo, run.suiteId);
      return runId;
    }

    /*
      The INSERT ... SELECT quietly skips an id that is deleted or in another
      suite, so the count is compared afterwards and a short run is refused.
      A run silently built from half of a stale selection is worse than an
      error: nobody notices until the coverage numbers are wrong.
    */
    const wanted = new Set(run.caseIds ?? []);
    let created = 0;
    for (const chunk of chunked([...wanted])) {
      const placeholders = chunk.map(() => "?").join(", ");
      created += database
        .prepare(
          `INSERT INTO tests (run_id, case_id, title_snapshot, assigned_to)
           SELECT ?, id, title, ? FROM cases
            WHERE id IN (${placeholders}) AND suite_id = ? AND is_deleted = 0`,
        )
        .run(runId, assignedTo, ...chunk, run.suiteId).changes;
    }
    if (created !== wanted.size) {
      throw new ConflictError(
        `${wanted.size - created} of ${wanted.size} cases are not live cases in suite ${run.suiteId}`,
      );
    }
    return runId;
  });
  return create();
}

export function updateRun(
  database: Database.Database,
  id: number,
  patch: { name?: string; description?: string | null; config?: string | null },
): void {
  const result = database
    .prepare(
      `UPDATE runs
          SET name        = COALESCE(?, name),
              description = CASE WHEN ? THEN ? ELSE description END,
              config      = CASE WHEN ? THEN ? ELSE config END
        WHERE id = ?`,
    )
    .run(
      patch.name ?? null,
      patch.description === undefined ? 0 : 1,
      patch.description ?? null,
      patch.config === undefined ? 0 : 1,
      patch.config ?? null,
      id,
    );
  assertChanged(result.changes, "run", id);
}

/*
  is_completed is a lock, not a label: see recordResults. Reopening destroys
  nothing, because closing never deleted anything - the results were all still
  there.
*/
export function setRunCompleted(
  database: Database.Database,
  id: number,
  isCompleted: boolean,
): void {
  const result = database
    .prepare("UPDATE runs SET is_completed = ? WHERE id = ?")
    .run(Number(isCompleted), id);
  assertChanged(result.changes, "run", id);
}

/*
  Close-or-reopen and rename arrive in one PATCH, so they commit together.
  Separately, a rejected rename would leave a run closed that the caller
  believes is still open.
*/
export function editRun(
  database: Database.Database,
  id: number,
  patch: {
    name?: string;
    description?: string | null;
    config?: string | null;
    isCompleted?: boolean;
  },
): void {
  const edit = database.transaction(() => {
    if (patch.isCompleted !== undefined) setRunCompleted(database, id, patch.isCompleted);
    if (patch.name !== undefined || patch.description !== undefined || patch.config !== undefined) {
      updateRun(database, id, {
        name: patch.name,
        description: patch.description,
        config: patch.config,
      });
    }
  });
  edit();
}

/*
  Counting and deleting in one transaction, because the number is what the
  caller reports back to a human. Two statements and the count is already
  stale by the time anyone reads it.
*/
export function deleteRunWithCount(database: Database.Database, id: number): number {
  const destroy = database.transaction(() => {
    const destroyed = countRunResults(database, id);
    deleteRun(database, id);
    return destroyed;
  });
  return destroy();
}

// Cascades to tests and results. The only genuinely destructive path in the
// product, which is why the caller is expected to have shown the count first.
export function deleteRun(database: Database.Database, id: number): void {
  const result = database.prepare("DELETE FROM runs WHERE id = ?").run(id);
  assertChanged(result.changes, "run", id);
}

export function countRunResults(database: Database.Database, runId: number): number {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS total FROM results
        WHERE test_id IN (SELECT id FROM tests WHERE run_id = ?)`,
    )
    .get(runId) as { total: number };
  return row.total;
}

export type TestFilter = ListOptions & {
  statusIds?: readonly number[];
  assignedTo?: number | null;
};

export function listTests(
  database: Database.Database,
  runId: number,
  filter: TestFilter = {},
): ListResult<TestRow> {
  const conditions = ["run_id = ?"];
  const values: unknown[] = [runId];

  if (filter.statusIds && filter.statusIds.length > 0) {
    conditions.push(`status_id IN (${filter.statusIds.map(() => "?").join(", ")})`);
    values.push(...filter.statusIds);
  }
  if (filter.assignedTo !== undefined && filter.assignedTo !== null) {
    conditions.push("assigned_to = ?");
    values.push(filter.assignedTo);
  }
  if (filter.search?.trim()) {
    conditions.push("title_snapshot LIKE ? ESCAPE '\\'");
    values.push(likePattern(filter.search));
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const total = (
    database.prepare(`SELECT COUNT(*) AS total FROM tests ${where}`).get(...values) as {
      total: number;
    }
  ).total;
  const rows = database
    .prepare(`SELECT * FROM tests ${where} ORDER BY id LIMIT ? OFFSET ?`)
    .all(...values, clampPageSize(filter.limit), offsetFor(filter.page, filter.limit)) as TestRow[];
  return paged(rows, total, filter);
}

export function getTest(database: Database.Database, id: number): TestRow | undefined {
  return database.prepare("SELECT * FROM tests WHERE id = ?").get(id) as TestRow | undefined;
}

/*
  Assignment is a work queue, not a lock: anyone may record a result on any
  test in an open run, and there is deliberately no ownership check anywhere
  below. In a real team the person free at five o'clock finishes someone
  else's run, and a tool that blocks that gets worked around within a week.
*/
export function assignTests(
  database: Database.Database,
  testIds: readonly number[],
  userId: number | null,
  runId?: number,
): number {
  if (testIds.length > MAX_BULK_IDS) {
    throw new ConflictError(`At most ${MAX_BULK_IDS} ids in one call, got ${testIds.length}`);
  }
  const assign = database.transaction(() => {
    if (runId !== undefined) assertTestsInRun(database, runId, testIds);
    let changed = 0;
    for (const chunk of chunked(testIds)) {
      const placeholders = chunk.map(() => "?").join(", ");
      changed += database
        .prepare(`UPDATE tests SET assigned_to = ? WHERE id IN (${placeholders})`)
        .run(userId, ...chunk).changes;
    }
    return changed;
  });
  return assign();
}

/*
  A route that names a run in its path has to mean it. Without this the id in
  /api/runs/2/tests/status was decorative: a body carrying a test from run 1
  recorded against run 1 and answered as though run 2 had changed, and a run
  id that did not exist at all answered the same way.
*/
export function assertTestsInRun(
  database: Database.Database,
  runId: number,
  testIds: readonly number[],
): void {
  if (!getRun(database, runId)) throw new NotFoundError(`No run with id ${runId}`);
  for (const chunk of chunked(testIds)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const found = database
      .prepare(
        `SELECT COUNT(*) AS total FROM tests WHERE run_id = ? AND id IN (${placeholders})`,
      )
      .get(runId, ...chunk) as { total: number };
    if (found.total !== new Set(chunk).size) {
      throw new ConflictError(`Some of those tests are not in run ${runId}`);
    }
  }
}

export type ResultInput = {
  /*
    The test, or the case plus the run it ran in. A CI reporter knows which
    case it executed, not which test row that became, and making it resolve
    the id first would be a second round trip plus a window where the run is
    closed between the two calls. Resolution happens inside the write
    transaction below instead.
  */
  testId?: number;
  caseId?: number;
  runId?: number;
  statusId: number;
  comment?: string | null;
  elapsed?: string | null;
  defects?: string | null;
  version?: string | null;
  assignedTo?: number | null;
  custom?: Record<string, unknown>;
  createdBy?: number | null;
};

type ResolvedResult = ResultInput & { testId: number };

/*
  Turns every entry into a concrete test id, inside the caller's transaction.
  A reporter posting by case id gets the same guarantees as one posting by test
  id: an unknown pair fails loud with the ids in the message, and the test the
  result lands on cannot change between the lookup and the insert.

  EXPLAIN QUERY PLAN over 200,000 tests (20,000 cases across 10 runs): SEARCH
  tests USING INDEX idx_tests_case (case_id=?), 0.002ms per lookup. 500 results
  posted by case id take 3.6ms against 2.6ms by test id - one millisecond for
  the whole batch, which is the price of not making CI resolve ids first.
*/
function resolveResultTargets(
  database: Database.Database,
  entries: readonly ResultInput[],
): ResolvedResult[] {
  if (entries.every((entry) => entry.testId !== undefined && entry.caseId === undefined)) {
    return entries as ResolvedResult[];
  }
  // createRun writes one test per case, so this is a single row; ordered by id
  // anyway, because "whichever row came back first" is not an answer.
  const findTest = database.prepare(
    "SELECT id FROM tests WHERE run_id = ? AND case_id = ? ORDER BY id LIMIT 1",
  );
  return entries.map((entry) => {
    if (entry.testId !== undefined) {
      if (entry.caseId !== undefined) {
        throw new ConflictError("A result names a test id or a case id, never both");
      }
      return entry as ResolvedResult;
    }
    if (entry.caseId === undefined || entry.runId === undefined) {
      throw new ConflictError("A result needs a test id, or a case id and a run id");
    }
    const found = findTest.get(entry.runId, entry.caseId) as { id: number } | undefined;
    if (!found) {
      throw new NotFoundError(`Case ${entry.caseId} is not in run ${entry.runId}`);
    }
    return { ...entry, testId: found.id };
  });
}

/*
  The one write path for a result. addResult, setStatusBulk and
  addResultsBulk all build entries and come through here, so there is a
  single place where a status is checked, a closed run is refused and
  tests.status_id is kept in step.

  Results are append-only: there is no update and no delete, and a correction
  is a new row. The denormalised tests.status_id is written by the same
  transaction that inserts the result, never by a second call, or the cache
  desyncs the first time a request dies midway.
*/
function recordResults(database: Database.Database, entries: readonly ResultInput[]): number[] {
  if (entries.length === 0) return [];
  if (entries.length > MAX_BULK_IDS) {
    throw new ConflictError(`At most ${MAX_BULK_IDS} results in one call, got ${entries.length}`);
  }

  const write = database.transaction(() => {
    const resolved = resolveResultTargets(database, entries);
    const statuses = new Map(listStatuses(database).map((status) => [status.id, status]));
    for (const entry of resolved) {
      const status = statuses.get(entry.statusId);
      if (!status) throw new NotFoundError(`No status with id ${entry.statusId}`);
      if (!isAssignableStatus(status)) {
        throw new ConflictError(
          `"${status.label}" is the absence of a result, not one that can be recorded`,
        );
      }
      if (needsComment(entry.statusId) && !entry.comment?.trim()) {
        throw new ConflictError(`A "${status.label}" result needs a comment`);
      }
    }

    const runOf = database.prepare(
      `SELECT runs.id AS run_id, runs.name, runs.is_completed
         FROM tests JOIN runs ON runs.id = tests.run_id
        WHERE tests.id = ?`,
    );
    for (const testId of new Set(resolved.map((entry) => entry.testId))) {
      const run = runOf.get(testId) as
        | { run_id: number; name: string; is_completed: number }
        | undefined;
      if (!run) throw new NotFoundError(`No test with id ${testId}`);
      if (run.is_completed === 1) {
        throw new ConflictError(`Run ${run.run_id} ("${run.name}") is closed`);
      }
    }

    const insert = database.prepare(
      `INSERT INTO results (test_id, status_id, comment, version, elapsed, defects,
                            assigned_to, custom, created_by, created_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const cacheStatus = database.prepare("UPDATE tests SET status_id = ? WHERE id = ?");
    const reassign = database.prepare("UPDATE tests SET assigned_to = ? WHERE id = ?");
    const timestamp = nowSeconds();
    const ids: number[] = [];

    for (const entry of resolved) {
      ids.push(
        Number(
          insert.run(
            entry.testId,
            entry.statusId,
            entry.comment ?? null,
            entry.version ?? null,
            entry.elapsed ?? null,
            entry.defects ?? null,
            entry.assignedTo ?? null,
            entry.custom ? JSON.stringify(entry.custom) : null,
            entry.createdBy ?? null,
            timestamp,
          ).lastInsertRowid,
        ),
      );
      cacheStatus.run(entry.statusId, entry.testId);
      // TestRail's reassign-on-result: how a failed test reaches the person
      // who will retest it. Absent means leave the assignee alone.
      if (entry.assignedTo !== undefined) reassign.run(entry.assignedTo, entry.testId);
    }
    return ids;
  });
  return write();
}

export function addResult(database: Database.Database, entry: ResultInput): number {
  return recordResults(database, [entry])[0];
}

// "Select forty rows and mark them all blocked". The same write as addResult,
// batched - not a second code path with its own idea of the rules.
export function setStatusBulk(
  database: Database.Database,
  testIds: readonly number[],
  statusId: number,
  options: { comment?: string | null; createdBy?: number | null; runId?: number } = {},
): number {
  const entries = testIds.map((testId) => ({
    testId,
    statusId,
    comment: options.comment ?? null,
    createdBy: options.createdBy ?? null,
  }));
  const write = database.transaction(() => {
    if (options.runId !== undefined) assertTestsInRun(database, options.runId, testIds);
    return recordResults(database, entries).length;
  });
  return write();
}

// The path a CI run actually uses: many tests, many statuses, one
// transaction. It must not be N round trips.
export function addResultsBulk(
  database: Database.Database,
  entries: readonly ResultInput[],
): number {
  return recordResults(database, entries).length;
}

export function listResults(
  database: Database.Database,
  testId: number,
  options: ListOptions = {},
): ListResult<ResultRow> {
  const total = (
    database.prepare("SELECT COUNT(*) AS total FROM results WHERE test_id = ?").get(testId) as {
      total: number;
    }
  ).total;
  // Newest first, straight off idx_results_test. This list is the change log;
  // there is no separate audit table.
  const rows = database
    .prepare(
      "SELECT * FROM results WHERE test_id = ? ORDER BY created_on DESC, id DESC LIMIT ? OFFSET ?",
    )
    .all(testId, clampPageSize(options.limit), offsetFor(options.page, options.limit)) as ResultRow[];
  return paged(rows, total, options);
}

/*
  The dashboard's numbers for one project: how many runs are open, and one
  status rollup across every test in every run of the project. Two aggregates,
  no row ever leaves SQLite to be counted in JS.

  The pass rate comes back inside a RunProgress, which means it arrives with
  its untested count attached and cannot be rendered alone - the same
  guarantee a single run gets.

  EXPLAIN QUERY PLAN over 20 runs holding 10,000 tests:
  SEARCH runs USING COVERING INDEX idx_runs_project, SEARCH tests USING
  COVERING INDEX idx_tests_run, then USE TEMP B-TREE FOR GROUP BY. The temp
  B-tree is left alone: it holds one row per distinct status, not one per test,
  and grouping across many run_ids cannot ride a single index. 1.0ms for the
  whole overview.
*/
export function projectOverview(
  database: Database.Database,
  projectId: number,
): ProjectOverview {
  const runCounts = database
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN is_completed = 0 THEN 1 ELSE 0 END) AS open_runs
         FROM runs WHERE project_id = ?`,
    )
    .get(projectId) as { total: number; open_runs: number | null };

  const counts = database
    .prepare(
      `SELECT tests.status_id, COUNT(*) AS total
         FROM tests JOIN runs ON runs.id = tests.run_id
        WHERE runs.project_id = ?
        GROUP BY tests.status_id`,
    )
    .all(projectId) as StatusCount[];

  return {
    openRuns: runCounts.open_runs ?? 0,
    totalRuns: runCounts.total,
    progress: runProgress(counts, listStatuses(database)),
  };
}

const MAX_ACTIVITY_ROWS = 50;

/*
  Recent activity is recent results, because results are the only history this
  product keeps. Ordered newest first and bounded here rather than by the
  caller, so a dashboard cannot ask for the whole table.
*/
export function recentActivity(
  database: Database.Database,
  projectId: number,
  limit = 10,
): ActivityRow[] {
  const wanted = Math.min(Math.max(Math.floor(Number(limit)) || 10, 1), MAX_ACTIVITY_ROWS);
  return database
    .prepare(
      `SELECT results.id, results.status_id, results.created_on, results.comment,
              results.test_id, tests.run_id, tests.title_snapshot,
              runs.name AS run_name, users.name AS author
         FROM results
         JOIN tests ON tests.id = results.test_id
         JOIN runs  ON runs.id = tests.run_id
         LEFT JOIN users ON users.id = results.created_by
        WHERE runs.project_id = ?
        ORDER BY results.created_on DESC, results.id DESC
        LIMIT ?`,
    )
    .all(projectId, wanted) as ActivityRow[];
}

/* Rollups are SQL aggregates. Never fetch tests and count them in JS. */

export function runSummary(database: Database.Database, runId: number): StatusCount[] {
  return database
    .prepare(
      "SELECT status_id, COUNT(*) AS total FROM tests WHERE run_id = ? GROUP BY status_id",
    )
    .all(runId) as StatusCount[];
}

export function planSummary(database: Database.Database, planId: number): StatusCount[] {
  return database
    .prepare(
      `SELECT tests.status_id, COUNT(*) AS total
         FROM tests JOIN runs ON runs.id = tests.run_id
        WHERE runs.plan_id = ?
        GROUP BY tests.status_id`,
    )
    .all(planId) as StatusCount[];
}

/*
  Milestones nest, so this rolls up the whole branch: the milestone's own runs
  plus every descendant milestone's. One recursive CTE, same level bound as
  the section tree for the same reason.
*/
export function milestoneSummary(
  database: Database.Database,
  milestoneId: number,
): StatusCount[] {
  return database
    .prepare(
      `WITH RECURSIVE branch AS (
         SELECT id, 0 AS level FROM milestones WHERE id = ?
          UNION ALL
         SELECT child.id, branch.level + 1
           FROM milestones child
           JOIN branch ON child.parent_id = branch.id
          WHERE branch.level + 1 < ?
       )
       SELECT tests.status_id, COUNT(*) AS total
         FROM tests
         JOIN runs ON runs.id = tests.run_id
        WHERE runs.milestone_id IN (SELECT id FROM branch)
        GROUP BY tests.status_id`,
    )
    .all(milestoneId, MAX_MILESTONE_LEVELS) as StatusCount[];
}

export function insertAttachment(
  database: Database.Database,
  attachment: {
    entityType: AttachmentEntity;
    entityId: number;
    filename: string;
    mime: string | null;
    size: number;
    storagePath: string;
  },
): number {
  const result = database
    .prepare(
      `INSERT INTO attachments (entity_type, entity_id, filename, mime, size, storage_path, created_on)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      attachment.entityType,
      attachment.entityId,
      attachment.filename,
      attachment.mime,
      attachment.size,
      attachment.storagePath,
      nowSeconds(),
    );
  return Number(result.lastInsertRowid);
}

export function getAttachment(database: Database.Database, id: number): AttachmentRow | undefined {
  return database.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as
    | AttachmentRow
    | undefined;
}

export function listAttachments(
  database: Database.Database,
  entityType: AttachmentEntity,
  entityId: number,
): AttachmentRow[] {
  return database
    .prepare(
      "SELECT * FROM attachments WHERE entity_type = ? AND entity_id = ? ORDER BY created_on, id",
    )
    .all(entityType, entityId) as AttachmentRow[];
}

/* ------------------------------------------------------------------ *
 * Migration
 *
 * Everything an import needs that the normal CRUD path cannot give it:
 * upserts keyed on (source, source_id), the lookups that resolve a
 * TestRail row to one of ours, and the import_runs bookkeeping that makes
 * a half-finished import resumable.
 *
 * The upserts report which of the three things happened, because the
 * acceptance test for the whole phase is that a second identical import
 * writes nothing: "inserted 0, updated 0" is only meaningful if unchanged
 * is counted separately (plan/04-testrail-migration.md section 5).
 * ------------------------------------------------------------------ */

export type UpsertAction = "inserted" | "updated" | "unchanged";

export type UpsertResult = { id: number; action: UpsertAction };

/*
  Every table an import writes into, with the columns the import owns.

  One generated statement per table rather than eleven hand-written ones: the
  shape is identical every time - insert, conflict on (source, source_id),
  update only the columns that actually differ - and eleven copies of it is
  eleven places for one of the OR clauses to go missing, which reads as
  "unchanged" and silently stops updating that column forever.

  Every identifier here is a literal in this file. Nothing in this map is
  ever built from a request value.

  `insertOnly` is written once and never compared. Every `created_on` is in
  there, and that is not a detail: a source row that carries no creation
  date falls back to the clock, and a clock in the comparison means the row
  reports "updated" on every single import and its dates walk forward by
  the length of the gap. Measured: a CSV with no `Created On` column
  rewrote all 243 timestamps on the second pass.

  `cases.is_deleted` is deliberately absent: a case deleted here stays
  deleted when the import is replayed. Re-importing is not an undelete.
*/
export type ImportTable =
  | "users"
  | "projects"
  | "suites"
  | "sections"
  | "milestones"
  | "cases"
  | "plans"
  | "runs"
  | "tests"
  | "results";

const IMPORT_COLUMNS: Record<
  ImportTable,
  { set: readonly string[]; insertOnly?: readonly string[] }
> = {
  users: { set: ["email", "name", "role", "is_active"], insertOnly: ["created_on"] },
  projects: {
    set: ["name", "announcement", "suite_mode", "is_completed"],
    insertOnly: ["created_on"],
  },
  suites: { set: ["project_id", "name", "description", "is_baseline", "baseline_of"] },
  sections: {
    set: ["suite_id", "parent_id", "depth", "display_order", "name", "description"],
  },
  milestones: {
    set: [
      "project_id",
      "parent_id",
      "name",
      "description",
      "due_on",
      "started_on",
      "is_completed",
    ],
  },
  cases: {
    set: [
      "section_id",
      "suite_id",
      "title",
      "template_id",
      "type_id",
      "priority_id",
      "refs",
      "estimate",
      "milestone_id",
      "custom",
      "created_by",
      "updated_by",
      "updated_on",
    ],
    insertOnly: ["created_on"],
  },
  plans: {
    set: ["project_id", "name", "description", "milestone_id", "is_completed"],
    insertOnly: ["created_on"],
  },
  runs: {
    set: [
      "project_id",
      "suite_id",
      "plan_id",
      "milestone_id",
      "name",
      "description",
      "config",
      "include_all",
      "is_completed",
    ],
    insertOnly: ["created_on"],
  },
  tests: { set: ["run_id", "case_id", "title_snapshot", "status_id", "assigned_to"] },
  results: {
    set: [
      "test_id",
      "status_id",
      "comment",
      "version",
      "elapsed",
      "defects",
      "assigned_to",
      "custom",
      "created_by",
    ],
    insertOnly: ["created_on"],
  },
};

export type ImportRow = Record<string, string | number | null> & {
  source: string;
  source_id: number;
};

export type ImportWriter = (row: ImportRow) => UpsertResult;

function upsertSql(table: ImportTable): string {
  const { set, insertOnly = [] } = IMPORT_COLUMNS[table];
  const inserted = [...set, ...insertOnly, "source", "source_id"];
  return `INSERT INTO ${table} (${inserted.join(", ")})
          VALUES (${inserted.map((column) => `@${column}`).join(", ")})
          ON CONFLICT(source, source_id) DO UPDATE SET
            ${set.map((column) => `${column} = excluded.${column}`).join(",\n            ")}
          WHERE ${set.map((column) => `${table}.${column} IS NOT excluded.${column}`).join("\n             OR ")}`;
}

/*
  Statements are compiled per connection, and an import calls these hundreds
  of thousands of times, so they are prepared once and kept against the
  connection. A WeakMap so a closed test database is still collectable.
*/
const preparedWriters = new WeakMap<
  Database.Database,
  Map<ImportTable, { probe: Database.Statement; upsert: Database.Statement }>
>();

function statementsFor(
  database: Database.Database,
  table: ImportTable,
): { probe: Database.Statement; upsert: Database.Statement } {
  let byTable = preparedWriters.get(database);
  if (!byTable) {
    byTable = new Map();
    preparedWriters.set(database, byTable);
  }
  const existing = byTable.get(table);
  if (existing) return existing;

  const prepared = {
    probe: database.prepare(`SELECT id FROM ${table} WHERE source = ? AND source_id = ?`),
    upsert: database.prepare(upsertSql(table)),
  };
  byTable.set(table, prepared);
  return prepared;
}

/*
  The probe is what separates "inserted" from "updated": `changes` reports 1
  for both, and 0 only when the conflict matched and nothing differed. It
  costs one seek on a UNIQUE index the schema already keeps.
*/
export function importWriter(database: Database.Database, table: ImportTable): ImportWriter {
  const { probe, upsert } = statementsFor(database, table);
  return (row) => {
    const existing = probe.get(row.source, row.source_id) as { id: number } | undefined;
    const info = upsert.run(row);
    if (existing === undefined) {
      return { id: Number(info.lastInsertRowid), action: "inserted" };
    }
    return { id: existing.id, action: info.changes > 0 ? "updated" : "unchanged" };
  };
}

export function upsertFromSource(
  database: Database.Database,
  table: ImportTable,
  row: ImportRow,
): UpsertResult {
  return importWriter(database, table)(row);
}

/*
  Users are the one import whose natural key is not (source, source_id): a
  TestRail user and a MiniTCMS user are the same person when the email
  matches, and `users.email` is UNIQUE. So an existing local account is
  claimed - stamped with the source so later imports find it by id - rather
  than inserted a second time and rejected.

  `password_hash` is never touched: an imported account cannot sign in until
  somebody sets a password, and re-importing must not lock out a user who
  already has one.
*/
export function upsertUserFromSource(
  database: Database.Database,
  user: {
    email: string;
    name: string | null;
    role: UserRole;
    isActive: boolean;
    source: string;
    sourceId: number;
  },
): UpsertResult {
  const email = normaliseEmail(user.email);
  const bySource = database
    .prepare("SELECT id FROM users WHERE source = ? AND source_id = ?")
    .get(user.source, user.sourceId) as { id: number } | undefined;

  if (!bySource) {
    const byEmail = database.prepare("SELECT id, source FROM users WHERE email = ?").get(email) as
      | { id: number; source: string | null }
      | undefined;
    if (byEmail) {
      const claimed = database
        .prepare(
          `UPDATE users SET name = COALESCE(?, name), source = ?, source_id = ?
            WHERE id = ? AND (name IS NOT ? OR source IS NOT ? OR source_id IS NOT ?)`,
        )
        .run(
          user.name,
          user.source,
          user.sourceId,
          byEmail.id,
          user.name,
          user.source,
          user.sourceId,
        );
      return { id: byEmail.id, action: claimed.changes > 0 ? "updated" : "unchanged" };
    }
  }

  return upsertFromSource(database, "users", {
    email,
    name: user.name,
    // Least privilege: TestRail's role ids are instance-specific, so an
    // imported account gets the lowest role and the mapping is reported.
    role: user.role,
    is_active: user.isActive ? 1 : 0,
    created_on: nowSeconds(),
    source: user.source,
    source_id: user.sourceId,
  });
}

/*
  Statuses are the one table keyed on TestRail's own id by construction
  (phase 1 pinned 1-5 to TestRail's). A custom status arrives at id >= 6 and
  is written as it is, so an imported status looks like itself everywhere
  without a translation table.
*/
export function upsertStatus(
  database: Database.Database,
  status: {
    id: number;
    systemName: string;
    label: string;
    color: string | null;
    isUntested: boolean;
    isFinal: boolean;
  },
): UpsertResult {
  const existing = database.prepare("SELECT id FROM statuses WHERE id = ?").get(status.id) as
    | { id: number }
    | undefined;
  const info = database
    .prepare(
      `INSERT INTO statuses (id, system_name, label, color, is_untested, is_final)
       VALUES (@id, @systemName, @label, @color, @isUntested, @isFinal)
       ON CONFLICT(id) DO UPDATE SET
         system_name = excluded.system_name,
         label       = excluded.label,
         color       = excluded.color,
         is_untested = excluded.is_untested,
         is_final    = excluded.is_final
       WHERE statuses.system_name IS NOT excluded.system_name
          OR statuses.label       IS NOT excluded.label
          OR statuses.color       IS NOT excluded.color
          OR statuses.is_untested IS NOT excluded.is_untested
          OR statuses.is_final    IS NOT excluded.is_final`,
    )
    .run({
      id: status.id,
      systemName: status.systemName,
      label: status.label,
      color: status.color,
      isUntested: status.isUntested ? 1 : 0,
      isFinal: status.isFinal ? 1 : 0,
    });
  if (!existing) return { id: status.id, action: "inserted" };
  return { id: status.id, action: info.changes > 0 ? "updated" : "unchanged" };
}

export function upsertSuiteFromSource(
  database: Database.Database,
  suite: {
    projectId: number;
    name: string;
    description?: string | null;
    isBaseline?: boolean;
    baselineOf?: number | null;
    source: string;
    sourceId: number;
  },
): UpsertResult {
  return upsertFromSource(database, "suites", {
    project_id: suite.projectId,
    name: suite.name,
    description: suite.description ?? null,
    is_baseline: suite.isBaseline ? 1 : 0,
    baseline_of: suite.baselineOf ?? null,
    source: suite.source,
    source_id: suite.sourceId,
  });
}

export type ImportCaseInput = {
  sectionId: number | null;
  suiteId: number;
  title: string;
  templateId: number;
  typeId: number | null;
  priorityId: number | null;
  refs: string | null;
  estimate: string | null;
  milestoneId: number | null;
  custom: string | null;
  createdBy: number | null;
  createdOn: number;
  updatedBy: number | null;
  /* null means the source carried no modification date - see
     existingCaseUpdatedOn for why that is not the same as "now". */
  updatedOn: number | null;
  source: string;
  sourceId: number;
};

export function caseImportRow(input: ImportCaseInput): ImportRow {
  return {
    section_id: input.sectionId,
    suite_id: input.suiteId,
    title: input.title,
    template_id: input.templateId,
    type_id: input.typeId,
    priority_id: input.priorityId,
    refs: input.refs,
    estimate: input.estimate,
    milestone_id: input.milestoneId,
    custom: input.custom,
    created_by: input.createdBy,
    created_on: input.createdOn,
    updated_by: input.updatedBy,
    updated_on: input.updatedOn ?? input.createdOn,
    source: input.source,
    source_id: input.sourceId,
  };
}

export function upsertCaseFromSource(
  database: Database.Database,
  input: ImportCaseInput,
): UpsertResult {
  const updatedOn =
    input.updatedOn ??
    existingCaseUpdatedOn(database, input.source, input.sourceId) ??
    input.createdOn;
  return upsertFromSource(database, "cases", caseImportRow({ ...input, updatedOn }));
}

/*
  TestRail ids resolved to ours, for one source, in one query. The import
  keeps it in memory for the length of the run so a parent reference is a Map
  lookup rather than a query per row, and a resumed import rebuilds it from
  the database instead of from the fetched pages.

  Memory ceiling: one entry per imported row, so roughly 20MB of Map for a
  200k-case instance. Bounded by the instance, not by the import.
*/
export function sourceIdMap(
  database: Database.Database,
  table: ImportTable,
  source: string,
): Map<number, number> {
  const rows = database
    .prepare(`SELECT source_id, id FROM ${table} WHERE source = ?`)
    .all(source) as { source_id: number; id: number }[];
  return new Map(rows.map((row) => [row.source_id, row.id]));
}

/*
  Every section in a suite, flat, for the importer to fold into a
  path -> id map in one pass. A CSV carries no section ids, so the only key
  a second import can match on is the resolved path - and resolving it one
  `SELECT … WHERE name = ?` at a time is a query per path per import.
*/
export function listSectionsFlat(
  database: Database.Database,
  suiteId: number,
): { id: number; parent_id: number | null; name: string }[] {
  /*
    Ordered by id so two siblings sharing a name resolve the same way every
    time. TestRail allows duplicate section names under one parent, and the
    importer keys on the resolved path - without an order, which of the two
    a case is filed under is whatever SQLite happened to return, and it can
    differ between imports of the same file.
  */
  return database
    .prepare("SELECT id, parent_id, name FROM sections WHERE suite_id = ? ORDER BY id")
    .all(suiteId) as { id: number; parent_id: number | null; name: string }[];
}

/*
  Identity in a CSV is a display name, not an email, so a match is only
  accepted when it is unique. Two rows back means ambiguous, and the caller
  leaves the column NULL and reports it rather than picking one. LIMIT 2
  because the third match tells us nothing the second did not.
*/
export function findUserIdsByName(database: Database.Database, name: string): number[] {
  const rows = database
    .prepare("SELECT id FROM users WHERE lower(name) = lower(?) LIMIT 2")
    .all(name) as { id: number }[];
  return rows.map((row) => row.id);
}

/*
  The trap in plan section 6.7: `UNIQUE(source, source_id)` is per source, so
  importing a CSV and then the API lands every case twice and the schema
  cannot see it. The importer asks this first and refuses unless the operator
  passes --allow-mixed-sources.
*/
/*
  30-40ms over 200k cases, through a temp B-tree for the GROUP BY.
  Deliberately left that way: it runs once per import, not once per row, and
  the only index that would remove the sort would exist for this one query.
*/
export function caseSourcesInProject(
  database: Database.Database,
  projectId: number,
): { source: string | null; total: number }[] {
  return database
    .prepare(
      `SELECT cases.source AS source, COUNT(*) AS total
         FROM cases
         JOIN suites ON suites.id = cases.suite_id
        WHERE suites.project_id = ?
        GROUP BY cases.source`,
    )
    .all(projectId) as { source: string | null; total: number }[];
}

/*
  What this row's updated_on already is, for an import whose source did not
  send one. "No information" has to mean "leave it alone": falling back to
  the clock makes the row differ from itself on every pass. Only read when
  the source actually omitted the field, which is rare.
*/
export function existingCaseUpdatedOn(
  database: Database.Database,
  source: string,
  sourceId: number,
): number | undefined {
  const row = database
    .prepare("SELECT updated_on FROM cases WHERE source = ? AND source_id = ?")
    .get(source, sourceId) as { updated_on: number } | undefined;
  return row?.updated_on;
}

export function createImportRun(database: Database.Database, source: string): number {
  const result = database
    .prepare("INSERT INTO import_runs (source, state, started_on) VALUES (?, 'running', ?)")
    .run(source, nowSeconds());
  return Number(result.lastInsertRowid);
}

export function updateImportRun(
  database: Database.Database,
  id: number,
  patch: { state?: ImportState; cursor?: string | null; report?: string | null },
): void {
  // finished_on is derived from the state rather than passed in, so a run
  // cannot be recorded as done with no end time.
  const finished = patch.state === "done" || patch.state === "failed" ? nowSeconds() : null;
  const result = database
    .prepare(
      `UPDATE import_runs
          SET state       = COALESCE(?, state),
              cursor      = CASE WHEN ? THEN ? ELSE cursor END,
              report      = CASE WHEN ? THEN ? ELSE report END,
              finished_on = COALESCE(?, finished_on)
        WHERE id = ?`,
    )
    .run(
      patch.state ?? null,
      patch.cursor === undefined ? 0 : 1,
      patch.cursor ?? null,
      patch.report === undefined ? 0 : 1,
      patch.report ?? null,
      finished,
      id,
    );
  assertChanged(result.changes, "import run", id);
}

export function getImportRun(
  database: Database.Database,
  id: number,
): ImportRunRow | undefined {
  return database.prepare("SELECT * FROM import_runs WHERE id = ?").get(id) as
    | ImportRunRow
    | undefined;
}

/*
  No `search` here, unlike the other lists: an import run has no name to
  search, and accepting a parameter that is silently dropped reads as a
  filter that works.
*/
export function listImportRuns(
  database: Database.Database,
  options: { limit?: unknown; page?: unknown } = {},
): ListResult<ImportRunRow> {
  const total = (
    database.prepare("SELECT COUNT(*) AS total FROM import_runs").get() as { total: number }
  ).total;
  const rows = database
    .prepare(
      `SELECT * FROM import_runs
        ORDER BY started_on DESC, id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(clampPageSize(options.limit), offsetFor(options.page, options.limit)) as ImportRunRow[];
  return paged(rows, total, options);
}
