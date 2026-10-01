import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  clearLoginAttempts,
  countLoginAttempts,
  countUsers,
  createUser,
  deleteExpiredSessions,
  deleteSession,
  findSessionUser,
  findUserByEmail,
  insertSession,
  nowSeconds,
  openDb,
  SCHEMA_VERSION,
} from "./db";

let directory: string;
let database: Database.Database;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "minitcms-"));
  database = openDb(join(directory, "test.db"));
});

afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

function seedUser(email = "tester@example.com") {
  return createUser(database, { email, role: "tester", passwordHash: "scrypt$x" });
}

describe("users", () => {
  it("normalises email on write and on read", () => {
    seedUser("  Tester@Example.COM ");
    const found = findUserByEmail(database, "tester@example.com");
    expect(found?.email).toBe("tester@example.com");
    expect(findUserByEmail(database, "TESTER@EXAMPLE.COM")?.id).toBe(found?.id);
  });

  it("rejects a duplicate email", () => {
    seedUser();
    expect(() => seedUser()).toThrow();
    expect(countUsers(database)).toBe(1);
  });
});

describe("schema", () => {
  it("rejects a role outside the allowed set", () => {
    expect(() =>
      database
        .prepare("INSERT INTO users (email, role, created_on) VALUES (?, ?, ?)")
        .run("rogue@example.com", "Designer", nowSeconds()),
    ).toThrow(/CHECK/i);
  });

  it("refuses to open a database stamped at another version", () => {
    const file = join(directory, "stale.db");
    const stale = openDb(file);
    stale.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION - 1);
    stale.close();
    expect(() => openDb(file)).toThrow(/schema is version/i);
  });
});

describe("sessions", () => {
  it("resolves a live session to its user", () => {
    const userId = seedUser();
    insertSession(database, {
      tokenHash: "hash-a",
      userId,
      expiresOn: nowSeconds() + 60,
      userAgent: null,
    });
    expect(findSessionUser(database, "hash-a")?.userId).toBe(userId);
  });

  it("refuses an expired session", () => {
    const userId = seedUser();
    insertSession(database, {
      tokenHash: "hash-b",
      userId,
      expiresOn: nowSeconds() - 1,
      userAgent: null,
    });
    expect(findSessionUser(database, "hash-b")).toBeUndefined();
    expect(deleteExpiredSessions(database)).toBe(1);
  });

  it("refuses a session whose user was deactivated", () => {
    const userId = seedUser();
    insertSession(database, {
      tokenHash: "hash-c",
      userId,
      expiresOn: nowSeconds() + 60,
      userAgent: null,
    });
    database.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(userId);
    expect(findSessionUser(database, "hash-c")).toBeUndefined();
  });

  it("drops sessions when the user is deleted", () => {
    const userId = seedUser();
    insertSession(database, {
      tokenHash: "hash-d",
      userId,
      expiresOn: nowSeconds() + 60,
      userAgent: null,
    });
    database.prepare("DELETE FROM users WHERE id = ?").run(userId);
    expect(findSessionUser(database, "hash-d")).toBeUndefined();
  });

  it("forgets a signed-out session", () => {
    const userId = seedUser();
    insertSession(database, {
      tokenHash: "hash-e",
      userId,
      expiresOn: nowSeconds() + 60,
      userAgent: null,
    });
    deleteSession(database, "hash-e");
    expect(findSessionUser(database, "hash-e")).toBeUndefined();
  });
});

describe("login attempts", () => {
  it("counts only attempts inside the window", () => {
    database
      .prepare("INSERT INTO login_attempts (identifier, attempted_on) VALUES (?, ?)")
      .run("email:a@example.com", nowSeconds() - 5000);
    database
      .prepare("INSERT INTO login_attempts (identifier, attempted_on) VALUES (?, ?)")
      .run("email:a@example.com", nowSeconds());
    expect(countLoginAttempts(database, "email:a@example.com", 900)).toBe(1);
  });

  it("clears attempts after a success", () => {
    database
      .prepare("INSERT INTO login_attempts (identifier, attempted_on) VALUES (?, ?)")
      .run("email:a@example.com", nowSeconds());
    clearLoginAttempts(database, "email:a@example.com");
    expect(countLoginAttempts(database, "email:a@example.com", 900)).toBe(0);
  });
});
