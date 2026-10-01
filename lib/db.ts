import Database from "better-sqlite3";
import {
  BUILT_IN_STATUSES,
  MAX_SECTION_DEPTH,
  RESULT_STATUS,
  USER_ROLES,
  type SessionUser,
  type UserRole,
  type UserRow,
} from "./format.ts";

export const SCHEMA_VERSION = 3;

// Interpolated at module load from a constant, never from a request value.
const ROLE_VALUES = USER_ROLES.map((role) => `'${role}'`).join(", ");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

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
  suite_mode   INTEGER NOT NULL DEFAULT 1 CHECK (suite_mode IN (1, 2, 3)),
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
  depth         INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0 AND depth < ${MAX_SECTION_DEPTH}),
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
  id           INTEGER PRIMARY KEY,
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
  updated_on   INTEGER NOT NULL,
  source       TEXT,
  source_id    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cases_section       ON cases(section_id);
CREATE INDEX IF NOT EXISTS idx_cases_suite         ON cases(suite_id, is_deleted);
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_source ON runs(source, source_id);

CREATE TABLE IF NOT EXISTS tests (
  id             INTEGER PRIMARY KEY,
  run_id         INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  case_id        INTEGER REFERENCES cases(id) ON DELETE SET NULL,
  title_snapshot TEXT NOT NULL,
  status_id      INTEGER NOT NULL DEFAULT ${RESULT_STATUS.untested} REFERENCES statuses(id),
  assigned_to    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source         TEXT,
  source_id      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tests_run           ON tests(run_id, status_id);
CREATE INDEX IF NOT EXISTS idx_tests_case          ON tests(case_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tests_source ON tests(source, source_id);

CREATE TABLE IF NOT EXISTS results (
  id          INTEGER PRIMARY KEY,
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
CREATE INDEX IF NOT EXISTS idx_results_test          ON results(test_id, created_on DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_results_source ON results(source, source_id);

CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY,
  entity_type  TEXT NOT NULL,
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
`;

export function openDb(file: string): Database.Database {
  const database = new Database(file);
  database.pragma("journal_mode = WAL");
  // Off by default in SQLite, and silently so: every cascade below depends on it.
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA);

  seedBuiltInStatuses(database);

  const stamped = database
    .prepare("SELECT version FROM schema_version LIMIT 1")
    .get() as { version: number } | undefined;
  if (!stamped) {
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  } else if (stamped.version !== SCHEMA_VERSION) {
    throw new Error(
      `Database schema is version ${stamped.version}, this build expects ${SCHEMA_VERSION}.`,
    );
  }
  return database;
}

// System rows, not seed data: the five ids are part of the contract with
// TestRail, and results carry a foreign key onto them.
function seedBuiltInStatuses(database: Database.Database): void {
  const insert = database.prepare(
    `INSERT INTO statuses (id, system_name, label, color, is_untested, is_final)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
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

export function clearLoginAttempts(database: Database.Database, identifier: string): void {
  database.prepare("DELETE FROM login_attempts WHERE identifier = ?").run(identifier);
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
