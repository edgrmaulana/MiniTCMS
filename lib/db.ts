import Database from "better-sqlite3";
import {
  ATTACHMENT_ENTITIES,
  BUILT_IN_STATUSES,
  CaseFieldError,
  MAX_SECTION_LEVELS,
  RESULT_STATUS,
  SUITE_MODE,
  USER_ROLES,
  clampPage,
  clampPageSize,
  offsetFor,
  validateCustom,
  type CaseFieldRow,
  type CaseRow,
  type ListResult,
  type ProjectRow,
  type SectionRow,
  type SessionUser,
  type SuiteMode,
  type SuiteRow,
  type UserRole,
  type UserRow,
} from "./format.ts";

export const SCHEMA_VERSION = 6;

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
CREATE INDEX IF NOT EXISTS idx_tests_run           ON tests(run_id, status_id);
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
CREATE INDEX IF NOT EXISTS idx_results_test          ON results(test_id, created_on DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_results_source ON results(source, source_id);

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

export type SectionTreeRow = {
  id: number;
  parent_id: number | null;
  depth: number;
  display_order: number;
  name: string;
  description: string | null;
  case_count: number;
};

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
): number {
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
      field.isGlobal === false ? 0 : 1,
      field.configs ?? null,
      field.source ?? null,
      field.sourceId ?? null,
    );
  // Read the id back rather than trusting lastInsertRowid: on the DO UPDATE
  // branch nothing was inserted and that value is left over from whatever this
  // connection inserted last, in whatever table.
  const row = database
    .prepare("SELECT id FROM case_fields WHERE system_name = ?")
    .get(field.systemName) as { id: number };
  return row.id;
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
