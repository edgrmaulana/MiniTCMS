import Database from "better-sqlite3";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'tester',
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
`;

export type UserRole = "admin" | "lead" | "tester";

export type UserRow = {
  id: number;
  email: string;
  name: string | null;
  role: UserRole;
  is_active: number;
  password_hash: string | null;
  created_on: number;
};

export type SessionUser = {
  userId: number;
  email: string;
  name: string | null;
  role: UserRole;
  expiresOn: number;
};

export function openDb(file: string): Database.Database {
  const database = new Database(file);
  database.pragma("journal_mode = WAL");
  // Off by default in SQLite, and silently so: every cascade below depends on it.
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA);

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
