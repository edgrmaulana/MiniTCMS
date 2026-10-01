import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  clearLoginAttempts,
  countLoginAttempts,
  countUsers,
  createUser,
  deleteExpiredLoginAttempts,
  deleteExpiredSessions,
  deleteSession,
  findSessionUser,
  findUserByEmail,
  insertSession,
  nowSeconds,
  openDb,
  SCHEMA_VERSION,
} from "./db";
import { MAX_SECTION_LEVELS, RESULT_STATUS } from "./format";

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

  it("refuses a stale database without touching it", () => {
    const file = join(directory, "untouched.db");
    const stale = openDb(file);
    stale.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION - 1);
    stale.prepare("DROP TABLE results").run();
    stale.close();

    expect(() => openDb(file)).toThrow(/schema is version/i);

    // Re-reading has to go through a raw connection: openDb refuses this file.
    const inspect = new Database(file);
    const recreated = inspect
      .prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE name = 'results'")
      .get() as { total: number };
    inspect.close();
    expect(recreated.total).toBe(0);
  });

});

describe("statuses", () => {
  it("seeds the five built-ins at their TestRail ids", () => {
    const rows = database
      .prepare("SELECT id, system_name FROM statuses ORDER BY id")
      .all() as { id: number; system_name: string }[];
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    expect(rows[0].system_name).toBe("passed");
    expect(rows[4].system_name).toBe("failed");
  });

  it("rejects a custom status that takes a built-in name", () => {
    expect(() =>
      database
        .prepare("INSERT INTO statuses (id, system_name, label) VALUES (9, 'passed', 'Passed?')")
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it("carries a corrected label into an existing database", () => {
    const file = join(directory, "relabel.db");
    const first = openDb(file);
    first.prepare("UPDATE statuses SET label = 'Wrong' WHERE id = 1").run();
    first.close();
    const second = openDb(file);
    const row = second.prepare("SELECT label FROM statuses WHERE id = 1").get() as {
      label: string;
    };
    second.close();
    expect(row.label).toBe("Passed");
  });

  it("does not duplicate them when the database is reopened", () => {
    const file = join(directory, "reopen.db");
    openDb(file).close();
    const second = openDb(file);
    const count = second.prepare("SELECT COUNT(*) AS total FROM statuses").get() as {
      total: number;
    };
    second.close();
    expect(count.total).toBe(5);
  });
});

describe("imported row identity", () => {
  it("rejects the same TestRail id twice in a table", () => {
    const insert = database.prepare(
      "INSERT INTO projects (name, created_on, source, source_id) VALUES (?, ?, 'testrail', ?)",
    );
    insert.run("Imported", nowSeconds(), 7);
    expect(() => insert.run("Imported again", nowSeconds(), 7)).toThrow(/UNIQUE/i);
  });

  it("allows any number of native rows, which carry no source", () => {
    const insert = database.prepare(
      "INSERT INTO projects (name, created_on) VALUES (?, ?)",
    );
    insert.run("Native one", nowSeconds());
    insert.run("Native two", nowSeconds());
    const count = database.prepare("SELECT COUNT(*) AS total FROM projects").get() as {
      total: number;
    };
    expect(count.total).toBe(2);
  });

  it("does not collide across sources", () => {
    database
      .prepare("INSERT INTO projects (name, created_on, source, source_id) VALUES (?, ?, ?, ?)")
      .run("From the API", nowSeconds(), "testrail", 7);
    expect(() =>
      database
        .prepare("INSERT INTO projects (name, created_on, source, source_id) VALUES (?, ?, ?, ?)")
        .run("From a CSV", nowSeconds(), "testrail-csv", 7),
    ).not.toThrow();
  });
});

describe("structural integrity", () => {
  function seedTree() {
    const projectId = Number(
      database
        .prepare("INSERT INTO projects (name, created_on) VALUES ('P', ?)")
        .run(nowSeconds()).lastInsertRowid,
    );
    const suiteId = Number(
      database
        .prepare("INSERT INTO suites (project_id, name) VALUES (?, 'S')")
        .run(projectId).lastInsertRowid,
    );
    const sectionId = Number(
      database
        .prepare("INSERT INTO sections (suite_id, name) VALUES (?, 'Sec')")
        .run(suiteId).lastInsertRowid,
    );
    const caseId = Number(
      database
        .prepare(
          `INSERT INTO cases (section_id, suite_id, title, created_on, updated_on)
           VALUES (?, ?, 'A case', ?, ?)`,
        )
        .run(sectionId, suiteId, nowSeconds(), nowSeconds()).lastInsertRowid,
    );
    return { projectId, suiteId, sectionId, caseId };
  }

  it("enforces foreign keys", () => {
    expect(() =>
      database.prepare("INSERT INTO suites (project_id, name) VALUES (999, 'orphan')").run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("cascades a deleted project down the tree", () => {
    const { projectId } = seedTree();
    database.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    for (const table of ["suites", "sections", "cases"]) {
      const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as {
        total: number;
      };
      expect(row.total, table).toBe(0);
    }
  });

  it("keeps run history when the case behind it is deleted", () => {
    const { projectId, suiteId, caseId } = seedTree();
    const runId = Number(
      database
        .prepare(
          "INSERT INTO runs (project_id, suite_id, name, created_on) VALUES (?, ?, 'R', ?)",
        )
        .run(projectId, suiteId, nowSeconds()).lastInsertRowid,
    );
    database
      .prepare("INSERT INTO tests (run_id, case_id, title_snapshot) VALUES (?, ?, 'A case')")
      .run(runId, caseId);

    database.prepare("DELETE FROM cases WHERE id = ?").run(caseId);

    const test = database
      .prepare("SELECT case_id, title_snapshot, status_id FROM tests")
      .get() as { case_id: number | null; title_snapshot: string; status_id: number };
    expect(test.case_id).toBeNull();
    expect(test.title_snapshot).toBe("A case");
    expect(test.status_id).toBe(RESULT_STATUS.untested);
  });

  it("keeps a case when the author behind it is deleted", () => {
    const { caseId } = seedTree();
    const authorId = Number(
      database
        .prepare("INSERT INTO users (email, role, created_on) VALUES (?, ?, ?)")
        .run("author@example.com", "tester", nowSeconds()).lastInsertRowid,
    );
    database
      .prepare("UPDATE cases SET created_by = ?, updated_by = ? WHERE id = ?")
      .run(authorId, authorId, caseId);

    database.prepare("DELETE FROM users WHERE id = ?").run(authorId);

    const caseRow = database
      .prepare("SELECT title, created_by, updated_by FROM cases WHERE id = ?")
      .get(caseId) as { title: string; created_by: number | null; updated_by: number | null };
    expect(caseRow.title).toBe("A case");
    expect(caseRow.created_by).toBeNull();
    expect(caseRow.updated_by).toBeNull();
  });

  it("refuses a result status that is not a known status", () => {
    const { projectId, suiteId } = seedTree();
    const runId = Number(
      database
        .prepare(
          "INSERT INTO runs (project_id, suite_id, name, created_on) VALUES (?, ?, 'R', ?)",
        )
        .run(projectId, suiteId, nowSeconds()).lastInsertRowid,
    );
    const testId = Number(
      database
        .prepare("INSERT INTO tests (run_id, title_snapshot) VALUES (?, 'T')")
        .run(runId).lastInsertRowid,
    );
    expect(() =>
      database
        .prepare("INSERT INTO results (test_id, status_id, created_on) VALUES (?, 99, ?)")
        .run(testId, nowSeconds()),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("allows the deepest legal section and rejects one below it", () => {
    const { suiteId } = seedTree();
    const insert = database.prepare(
      "INSERT INTO sections (suite_id, name, depth) VALUES (?, 'deep', ?)",
    );
    expect(() => insert.run(suiteId, MAX_SECTION_LEVELS - 1)).not.toThrow();
    expect(() => insert.run(suiteId, MAX_SECTION_LEVELS)).toThrow(/CHECK/i);
  });

  it("never re-uses the id of a deleted case, so attachments cannot be inherited", () => {
    const { suiteId, sectionId, caseId } = seedTree();
    database
      .prepare(
        `INSERT INTO attachments (entity_type, entity_id, filename, storage_path, created_on)
         VALUES ('case', ?, 'secret.pdf', 'a/b', ?)`,
      )
      .run(caseId, nowSeconds());
    database.prepare("DELETE FROM cases WHERE id = ?").run(caseId);

    const replacement = database
      .prepare(
        `INSERT INTO cases (section_id, suite_id, title, created_on, updated_on)
         VALUES (?, ?, 'A different case', ?, ?)`,
      )
      .run(sectionId, suiteId, nowSeconds(), nowSeconds());

    expect(Number(replacement.lastInsertRowid)).not.toBe(caseId);
    const inherited = database
      .prepare("SELECT COUNT(*) AS total FROM attachments WHERE entity_type = 'case' AND entity_id = ?")
      .get(Number(replacement.lastInsertRowid)) as { total: number };
    expect(inherited.total).toBe(0);
  });

  it("rejects an attachment on an entity type that cannot have one", () => {
    expect(() =>
      database
        .prepare(
          `INSERT INTO attachments (entity_type, entity_id, filename, storage_path, created_on)
           VALUES ('project', 1, 'f.pdf', 'a/b', ?)`,
        )
        .run(nowSeconds()),
    ).toThrow(/CHECK/i);
  });

  it("rejects a suite mode TestRail does not define", () => {
    expect(() =>
      database
        .prepare("INSERT INTO projects (name, suite_mode, created_on) VALUES ('P', 4, ?)")
        .run(nowSeconds()),
    ).toThrow(/CHECK/i);
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

  it("prunes rows that fell out of the window", () => {
    const insert = database.prepare(
      "INSERT INTO login_attempts (identifier, attempted_on) VALUES (?, ?)",
    );
    insert.run("ip:1.2.3.4", nowSeconds() - 5000);
    insert.run("ip:5.6.7.8", nowSeconds() - 5000);
    insert.run("email:a@example.com", nowSeconds());

    expect(deleteExpiredLoginAttempts(database, 900)).toBe(2);
    const left = database.prepare("SELECT COUNT(*) AS total FROM login_attempts").get() as {
      total: number;
    };
    expect(left.total).toBe(1);
  });

  it("clears attempts after a success", () => {
    database
      .prepare("INSERT INTO login_attempts (identifier, attempted_on) VALUES (?, ?)")
      .run("email:a@example.com", nowSeconds());
    clearLoginAttempts(database, "email:a@example.com");
    expect(countLoginAttempts(database, "email:a@example.com", 900)).toBe(0);
  });
});
