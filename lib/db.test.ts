import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  API_KEY_TOUCH_SECONDS,
  ConflictError,
  clearLoginAttempts,
  countLoginAttempts,
  countUsers,
  createUser,
  deleteExpiredLoginAttempts,
  deleteExpiredSessions,
  deleteSession,
  findApiKeyUser,
  findSessionUser,
  findUserByEmail,
  insertApiKey,
  NotFoundError,
  insertSession,
  listApiKeys,
  revokeApiKey,
  touchApiKey,
  nowSeconds,
  openDb,
  SCHEMA_VERSION,
  bulkMoveCases,
  bulkUpdateCases,
  createCase,
  createProject,
  createSection,
  createSuite,
  deleteCase,
  editSection,
  getCase,
  MAX_BULK_IDS,
  listCaseFields,
  listCases,
  listRunsWithProgress,
  projectOverview,
  recentActivity,
  listUsers,
  listProjects,
  moveSection,
  sectionTree,
  updateCase,
  upsertCaseField,
  addResult,
  addResultsBulk,
  assignTests,
  countRunResults,
  createMilestone,
  createPlan,
  createRun,
  deleteRun,
  editRun,
  getRun,
  getTest,
  listResults,
  listStatuses,
  listTests,
  milestoneSummary,
  planSummary,
  runSummary,
  setRunCompleted,
  setStatusBulk,
} from "./db";
import { storageNameFor } from "./attachments";
import {
  CASE_PRIORITY,
  CASE_TYPE,
  FIRST_CUSTOM_STATUS_ID,
  MAX_SECTION_LEVELS,
  RESULT_STATUS,
  formatElapsed,
  parseElapsed,
  runProgress,
} from "./format";

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

describe("api keys", () => {
  function seedKey(userId: number, name = "ci", keyHash = "hash-key-a") {
    return insertApiKey(database, { userId, name, keyHash });
  }

  it("resolves a key to its owner, with the owner's role", () => {
    const userId = createUser(database, {
      email: "lead@example.com",
      role: "lead",
      passwordHash: null,
    });
    seedKey(userId);
    const found = findApiKeyUser(database, "hash-key-a");
    expect(found?.userId).toBe(userId);
    expect(found?.role).toBe("lead");
    // No expiry, and the key id so the request can be rate limited and stamped.
    expect(found?.expiresOn).toBeNull();
    expect(found?.apiKeyId).toBeGreaterThan(0);
  });

  it("refuses an unknown hash", () => {
    seedKey(seedUser());
    expect(findApiKeyUser(database, "hash-nobody")).toBeUndefined();
  });

  it("refuses a revoked key and says so on a second revoke", () => {
    const keyId = seedKey(seedUser());
    revokeApiKey(database, keyId);
    expect(findApiKeyUser(database, "hash-key-a")).toBeUndefined();
    expect(() => revokeApiKey(database, keyId)).toThrow(ConflictError);
    expect(() => revokeApiKey(database, keyId + 99)).toThrow(NotFoundError);
  });

  it("refuses a key whose owner was deactivated", () => {
    const userId = seedUser();
    seedKey(userId);
    database.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(userId);
    expect(findApiKeyUser(database, "hash-key-a")).toBeUndefined();
  });

  it("goes with the user when the user goes", () => {
    const userId = seedUser();
    seedKey(userId);
    database.prepare("DELETE FROM users WHERE id = ?").run(userId);
    const left = database.prepare("SELECT COUNT(*) AS total FROM api_keys").get() as {
      total: number;
    };
    expect(left.total).toBe(0);
  });

  it("stamps last use, then leaves it alone inside the window", () => {
    const keyId = seedKey(seedUser());
    touchApiKey(database, keyId);
    const first = database
      .prepare("SELECT last_used_on FROM api_keys WHERE id = ?")
      .get(keyId) as { last_used_on: number };
    expect(first.last_used_on).toBeGreaterThan(0);

    // Pretend the stamp is one second old: inside the window, so a second
    // request must not write again.
    database
      .prepare("UPDATE api_keys SET last_used_on = ? WHERE id = ?")
      .run(nowSeconds() - 1, keyId);
    touchApiKey(database, keyId);
    const second = database
      .prepare("SELECT last_used_on FROM api_keys WHERE id = ?")
      .get(keyId) as { last_used_on: number };
    expect(second.last_used_on).toBe(nowSeconds() - 1);

    database
      .prepare("UPDATE api_keys SET last_used_on = ? WHERE id = ?")
      .run(nowSeconds() - API_KEY_TOUCH_SECONDS - 1, keyId);
    touchApiKey(database, keyId);
    const third = database
      .prepare("SELECT last_used_on FROM api_keys WHERE id = ?")
      .get(keyId) as { last_used_on: number };
    expect(third.last_used_on).toBe(nowSeconds());
  });

  it("lists keys without their hash, newest first, filtered by owner", () => {
    const first = seedUser("one@example.com");
    const second = seedUser("two@example.com");
    seedKey(first, "one ci", "hash-1");
    const newest = seedKey(second, "two ci", "hash-2");

    const all = listApiKeys(database, {});
    expect(all.total).toBe(2);
    expect(all.rows[0].id).toBe(newest);
    expect(all.rows[0].email).toBe("two@example.com");
    for (const row of all.rows) {
      expect(Object.keys(row)).not.toContain("key_hash");
    }

    const mine = listApiKeys(database, { userId: first });
    expect(mine.total).toBe(1);
    expect(mine.rows[0].name).toBe("one ci");
  });
});

describe("case repository", () => {
  function seedSuite() {
    const projectId = createProject(database, { name: "Payments" });
    const suiteId = createSuite(database, { projectId, name: "API" });
    return { projectId, suiteId };
  }

  it("pages a project list and reports the unpaged total", () => {
    for (let index = 0; index < 30; index += 1) {
      createProject(database, { name: `Project ${String(index).padStart(2, "0")}` });
    }
    const second = listProjects(database, { page: 2, limit: 25 });
    expect(second.total).toBe(30);
    expect(second.rows).toHaveLength(5);
    expect(second.rows[0].name).toBe("Project 25");
  });

  it("treats LIKE wildcards in a search as literal characters", () => {
    createProject(database, { name: "100% coverage" });
    createProject(database, { name: "nothing to see" });
    expect(listProjects(database, { search: "100%" }).total).toBe(1);
    // Without ESCAPE this pattern matches every row.
    expect(listProjects(database, { search: "%" }).total).toBe(1);
  });

  it("returns the whole section tree in render order from one query", () => {
    const { suiteId } = seedSuite();
    const api = createSection(database, { suiteId, name: "api" });
    const debt = createSection(database, { suiteId, parentId: api, name: "debt" });
    createSection(database, { suiteId, parentId: debt, name: "list" });
    const health = createSection(database, { suiteId, name: "health" });
    createCase(database, { suiteId, sectionId: health, title: "healthy" });

    const tree = sectionTree(database, suiteId);
    expect(tree.map((node) => node.name)).toEqual(["api", "debt", "list", "health"]);
    expect(tree.map((node) => node.depth)).toEqual([0, 1, 2, 0]);
    expect(tree.find((node) => node.name === "health")?.case_count).toBe(1);
  });

  it("refuses a section deeper than the cap", () => {
    const { suiteId } = seedSuite();
    let parentId: number | null = null;
    for (let level = 0; level < MAX_SECTION_LEVELS; level += 1) {
      parentId = createSection(database, { suiteId, parentId, name: `level ${level}` });
    }
    expect(() => createSection(database, { suiteId, parentId, name: "too deep" })).toThrow(
      /levels deep at most/i,
    );
  });

  it("rewrites descendant depth when a section moves", () => {
    const { suiteId } = seedSuite();
    const api = createSection(database, { suiteId, name: "api" });
    const debt = createSection(database, { suiteId, parentId: api, name: "debt" });
    createSection(database, { suiteId, parentId: debt, name: "list" });

    moveSection(database, debt, null);

    const byName = new Map(sectionTree(database, suiteId).map((node) => [node.name, node]));
    expect(byName.get("debt")?.depth).toBe(0);
    expect(byName.get("debt")?.parent_id).toBeNull();
    expect(byName.get("list")?.depth).toBe(1);
    expect(byName.get("list")?.parent_id).toBe(debt);
  });

  it("rejects a move into its own descendant, and into itself", () => {
    const { suiteId } = seedSuite();
    const api = createSection(database, { suiteId, name: "api" });
    const debt = createSection(database, { suiteId, parentId: api, name: "debt" });

    expect(() => moveSection(database, api, debt)).toThrow(/inside section/i);
    expect(() => moveSection(database, api, api)).toThrow(/its own parent/i);
    expect(sectionTree(database, suiteId).find((node) => node.name === "api")?.parent_id).toBeNull();
  });

  it("rejects a move that would push a subtree past the cap", () => {
    const { suiteId } = seedSuite();
    let deepest: number | null = null;
    for (let level = 0; level < MAX_SECTION_LEVELS - 1; level += 1) {
      deepest = createSection(database, { suiteId, parentId: deepest, name: `level ${level}` });
    }
    const loose = createSection(database, { suiteId, name: "loose" });
    const looseChild = createSection(database, { suiteId, parentId: loose, name: "loose child" });
    createSection(database, { suiteId, parentId: looseChild, name: "loose grandchild" });

    expect(() => moveSection(database, loose, deepest)).toThrow(/levels deep/i);
  });

  it("pages a case list and filters by section without a second pager", () => {
    const { suiteId } = seedSuite();
    const first = createSection(database, { suiteId, name: "first" });
    const second = createSection(database, { suiteId, name: "second" });
    for (let index = 0; index < 60; index += 1) {
      createCase(database, {
        suiteId,
        sectionId: index < 40 ? first : second,
        title: `Case ${String(index).padStart(3, "0")}`,
      });
    }
    const page = listCases(database, suiteId, { page: 2, limit: 25 });
    expect(page.total).toBe(60);
    expect(page.rows).toHaveLength(25);
    expect(listCases(database, suiteId, { sectionId: second }).total).toBe(20);
    expect(listCases(database, suiteId, { search: "Case 04" }).total).toBe(10);
  });

  it("refuses a case in a section that belongs to another suite", () => {
    const { projectId, suiteId } = seedSuite();
    const otherSuite = createSuite(database, { projectId, name: "Other" });
    const section = createSection(database, { suiteId, name: "here" });
    expect(() => createCase(database, { suiteId: otherSuite, sectionId: section, title: "x" })).toThrow(
      /another suite/i,
    );
  });

  it("validates a custom value against its field definition", () => {
    const { suiteId } = seedSuite();
    upsertCaseField(database, {
      systemName: "platform",
      label: "Platform",
      type: "dropdown",
      configs: JSON.stringify({ options: { items: ["API", "Web"] } }),
    });
    upsertCaseField(database, { systemName: "flaky", label: "Flaky", type: "checkbox" });

    const caseId = createCase(database, {
      suiteId,
      title: "ok",
      custom: { platform: "API", flaky: true },
    });
    expect(JSON.parse(getCase(database, caseId)?.custom ?? "{}")).toEqual({
      platform: "API",
      flaky: true,
    });
    expect(() =>
      createCase(database, { suiteId, title: "bad", custom: { platform: "Carrier pigeon" } }),
    ).toThrow(/one of API, Web/);
    expect(() => createCase(database, { suiteId, title: "bad", custom: { flaky: "yes" } })).toThrow(
      /true or false/,
    );
  });

  it("rejects an undefined custom field by default and keeps it for an import", () => {
    const { suiteId } = seedSuite();
    expect(() => createCase(database, { suiteId, title: "x", custom: { mystery: "1" } })).toThrow(
      /No such custom field: mystery/,
    );
    const imported = createCase(database, {
      suiteId,
      title: "y",
      custom: { mystery: "1" },
      allowUnknownCustom: true,
    });
    expect(JSON.parse(getCase(database, imported)?.custom ?? "{}")).toEqual({ mystery: "1" });
  });

  it("corrects a field definition in place rather than duplicating it", () => {
    const first = upsertCaseField(database, {
      systemName: "platform",
      label: "Platform",
      type: "text",
      source: "testrail-csv",
    });
    expect(first.action).toBe("inserted");
    const second = upsertCaseField(database, {
      systemName: "platform",
      label: "Platform",
      type: "dropdown",
      configs: JSON.stringify({ options: { items: ["API"] } }),
    });
    expect(second.id).toBe(first.id);
    expect(second.action).toBe("updated");
    const third = upsertCaseField(database, {
      systemName: "platform",
      label: "Platform",
      type: "dropdown",
      configs: JSON.stringify({ options: { items: ["API"] } }),
    });
    expect(third.action).toBe("unchanged");
    expect(listCaseFields(database)).toHaveLength(1);
    expect(listCaseFields(database)[0].type).toBe("dropdown");
  });

  it("stamps updated_by on every write, including the soft delete", () => {
    const { suiteId } = seedSuite();
    const editorId = createUser(database, {
      email: "editor@example.com",
      role: "lead",
      passwordHash: null,
    });
    const caseId = createCase(database, { suiteId, title: "before" });
    expect(getCase(database, caseId)?.updated_by).toBeNull();

    updateCase(database, caseId, { title: "after" }, editorId);
    expect(getCase(database, caseId)?.title).toBe("after");
    expect(getCase(database, caseId)?.updated_by).toBe(editorId);

    deleteCase(database, caseId, editorId);
    expect(getCase(database, caseId)).toBeUndefined();
    const deleted = database
      .prepare("SELECT is_deleted, updated_by FROM cases WHERE id = ?")
      .get(caseId) as { is_deleted: number; updated_by: number };
    expect(deleted.is_deleted).toBe(1);
    expect(deleted.updated_by).toBe(editorId);
  });

  it("keeps a soft-deleted case joinable from its tests", () => {
    const { projectId, suiteId } = seedSuite();
    const caseId = createCase(database, { suiteId, title: "ran once" });
    const runId = Number(
      database
        .prepare("INSERT INTO runs (project_id, suite_id, name, created_on) VALUES (?, ?, 'R', ?)")
        .run(projectId, suiteId, nowSeconds()).lastInsertRowid,
    );
    database
      .prepare("INSERT INTO tests (run_id, case_id, title_snapshot) VALUES (?, ?, 'ran once')")
      .run(runId, caseId);

    deleteCase(database, caseId, null);

    const joined = database
      .prepare(
        "SELECT cases.title FROM tests JOIN cases ON cases.id = tests.case_id WHERE tests.run_id = ?",
      )
      .get(runId) as { title: string } | undefined;
    expect(joined?.title).toBe("ran once");
  });

  it("moves more cases than SQLite will bind in one statement", () => {
    const { suiteId } = seedSuite();
    const from = createSection(database, { suiteId, name: "from" });
    const to = createSection(database, { suiteId, name: "to" });
    const caseIds: number[] = [];
    for (let index = 0; index < 1200; index += 1) {
      caseIds.push(createCase(database, { suiteId, sectionId: from, title: `Case ${index}` }));
    }
    expect(bulkMoveCases(database, caseIds, to, null)).toBe(1200);
    expect(listCases(database, suiteId, { sectionId: to }).total).toBe(1200);
    expect(listCases(database, suiteId, { sectionId: from }).total).toBe(0);
  });

  it("will not bulk move cases out of their own suite", () => {
    const { projectId, suiteId } = seedSuite();
    const otherSuite = createSuite(database, { projectId, name: "Other" });
    const elsewhere = createSection(database, { suiteId: otherSuite, name: "elsewhere" });
    const caseId = createCase(database, { suiteId, title: "stays" });

    expect(bulkMoveCases(database, [caseId], elsewhere, null)).toBe(0);
    expect(getCase(database, caseId)?.section_id).toBeNull();
  });

  it("leaves an untouched custom bag alone instead of writing it back", () => {
    const { suiteId } = seedSuite();
    upsertCaseField(database, { systemName: "owner", label: "Owner", type: "string" });
    const caseId = createCase(database, { suiteId, title: "a", custom: { owner: "qa" } });

    // Stands in for a concurrent edit landing between this caller's read and
    // its write: the title update must not revert it.
    database.prepare("UPDATE cases SET custom = ? WHERE id = ?").run('{"owner":"dev"}', caseId);
    updateCase(database, caseId, { title: "b" }, null);

    expect(JSON.parse(getCase(database, caseId)?.custom ?? "{}")).toEqual({ owner: "dev" });
  });

  it("rolls the rename back when the move in the same edit is rejected", () => {
    const { suiteId } = seedSuite();
    const api = createSection(database, { suiteId, name: "api" });
    const debt = createSection(database, { suiteId, parentId: api, name: "debt" });

    expect(() => editSection(database, api, { name: "renamed", parentId: debt })).toThrow(
      /inside section/i,
    );
    expect(sectionTree(database, suiteId)[0].name).toBe("api");
  });

  it("refuses a bulk call larger than the cap", () => {
    const { suiteId } = seedSuite();
    const section = createSection(database, { suiteId, name: "s" });
    const tooMany = Array.from({ length: MAX_BULK_IDS + 1 }, (_unused, index) => index + 1);
    expect(() => bulkMoveCases(database, tooMany, section, null)).toThrow(/At most/);
    expect(() => bulkUpdateCases(database, tooMany, { typeId: 1 }, null)).toThrow(/At most/);
  });

  it("answers a case page without sorting the whole suite", () => {
    const { suiteId } = seedSuite();
    const section = createSection(database, { suiteId, name: "s" });
    for (let index = 0; index < 50; index += 1) {
      createCase(database, { suiteId, sectionId: section, title: `Case ${index}` });
    }
    const plan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM cases WHERE suite_id = ? AND is_deleted = 0
          ORDER BY section_id, id LIMIT ? OFFSET ?`,
      )
      .all(suiteId, 25, 0) as { detail: string }[];
    // A temp B-tree here means every page sorts the entire filtered set -
    // 116ms per page at 100k cases when this index was one column narrower.
    expect(plan.map((step) => step.detail).join(" ")).not.toMatch(/TEMP B-TREE/);
  });

  it("bulk updates only the fields it was given", () => {
    const { suiteId } = seedSuite();
    const caseIds = [
      createCase(database, { suiteId, title: "a", typeId: CASE_TYPE.functional, priorityId: CASE_PRIORITY.low }),
      createCase(database, { suiteId, title: "b", typeId: CASE_TYPE.functional, priorityId: CASE_PRIORITY.low }),
    ];
    expect(bulkUpdateCases(database, caseIds, { priorityId: CASE_PRIORITY.critical }, null)).toBe(2);
    for (const caseId of caseIds) {
      const row = getCase(database, caseId);
      expect(row?.priority_id).toBe(CASE_PRIORITY.critical);
      expect(row?.type_id).toBe(CASE_TYPE.functional);
    }
  });
});

describe("execution", () => {
  function seedRun(caseCount = 3) {
    const projectId = createProject(database, { name: "Payments" });
    const suiteId = createSuite(database, { projectId, name: "API" });
    const section = createSection(database, { suiteId, name: "health" });
    for (let index = 0; index < caseCount; index += 1) {
      createCase(database, { suiteId, sectionId: section, title: `Case ${index}` });
    }
    const runId = createRun(database, { projectId, suiteId, name: "Regression", includeAll: true });
    return { projectId, suiteId, runId };
  }

  // Pages rather than asking for one big limit: clampPageSize snaps anything
  // outside PAGE_SIZES back to the default, so "give me all of them" is not
  // a thing a caller gets to ask for, in a test either.
  function testIdsOf(runId: number): number[] {
    const ids: number[] = [];
    for (let page = 1; ; page += 1) {
      const slice = listTests(database, runId, { page, limit: 100 });
      ids.push(...slice.rows.map((test) => test.id));
      if (ids.length >= slice.total) return ids;
    }
  }

  it("snapshots the case set, and the titles with it", () => {
    const { suiteId, runId } = seedRun(2);
    const caseId = listCases(database, suiteId, {}).rows[0].id;

    updateCase(database, caseId, { title: "renamed after the run" }, null);
    deleteCase(database, listCases(database, suiteId, {}).rows[0].id, null);

    const tests = listTests(database, runId, {});
    expect(tests.total).toBe(2);
    expect(tests.rows.map((test) => test.title_snapshot).sort()).toEqual(["Case 0", "Case 1"]);
  });

  it("starts every test untested, with no result rows", () => {
    const { runId } = seedRun(3);
    expect(runSummary(database, runId)).toEqual([
      { status_id: RESULT_STATUS.untested, total: 3 },
    ]);
    const results = database.prepare("SELECT COUNT(*) AS total FROM results").get() as {
      total: number;
    };
    expect(results.total).toBe(0);
  });

  it("refuses to record untested as a result", () => {
    const { runId } = seedRun(1);
    expect(() =>
      addResult(database, { testId: testIdsOf(runId)[0], statusId: RESULT_STATUS.untested }),
    ).toThrow(/absence of a result/i);
  });

  it("requires a comment for failed and blocked, but not for passed", () => {
    const { runId } = seedRun(2);
    const [first, second] = testIdsOf(runId);
    expect(() => addResult(database, { testId: first, statusId: RESULT_STATUS.failed })).toThrow(
      /needs a comment/i,
    );
    expect(() =>
      addResult(database, { testId: first, statusId: RESULT_STATUS.blocked, comment: "   " }),
    ).toThrow(/needs a comment/i);
    expect(() => addResult(database, { testId: second, statusId: RESULT_STATUS.passed })).not.toThrow();
  });

  it("keeps every result and reads the latest as the test status", () => {
    const { runId } = seedRun(1);
    const [testId] = testIdsOf(runId);
    addResult(database, { testId, statusId: RESULT_STATUS.failed, comment: "timeout" });
    addResult(database, { testId, statusId: RESULT_STATUS.retest });
    addResult(database, { testId, statusId: RESULT_STATUS.passed });

    expect(getTest(database, testId)?.status_id).toBe(RESULT_STATUS.passed);
    const history = listResults(database, testId, {});
    expect(history.total).toBe(3);
    expect(history.rows.map((row) => row.status_id)).toEqual([
      RESULT_STATUS.passed,
      RESULT_STATUS.retest,
      RESULT_STATUS.failed,
    ]);
  });

  it("writes the result and the cached status in one transaction", () => {
    const { runId } = seedRun(1);
    const [testId] = testIdsOf(runId);
    // A status that passes the assignable check and then fails the foreign
    // key, so the failure lands between the insert and the cache update.
    database.prepare("INSERT INTO statuses (id, system_name, label) VALUES (99, 'ghost', 'Ghost')").run();
    database.prepare("DELETE FROM statuses WHERE id = 99").run();

    expect(() => addResult(database, { testId, statusId: 99 })).toThrow();
    const results = database.prepare("SELECT COUNT(*) AS total FROM results").get() as {
      total: number;
    };
    expect(results.total).toBe(0);
    expect(getTest(database, testId)?.status_id).toBe(RESULT_STATUS.untested);
  });

  it("locks a closed run against every write path, and unlocks on reopen", () => {
    const { runId } = seedRun(2);
    const ids = testIdsOf(runId);
    setRunCompleted(database, runId, true);

    expect(() => addResult(database, { testId: ids[0], statusId: RESULT_STATUS.passed })).toThrow(
      new RegExp(`Run ${runId}`),
    );
    expect(() => setStatusBulk(database, ids, RESULT_STATUS.passed)).toThrow(/is closed/i);
    expect(() =>
      addResultsBulk(database, [{ testId: ids[0], statusId: RESULT_STATUS.passed }]),
    ).toThrow(/is closed/i);

    setRunCompleted(database, runId, false);
    expect(() => addResult(database, { testId: ids[0], statusId: RESULT_STATUS.passed })).not.toThrow();
  });

  it("records a bulk status as one result per test", () => {
    const { runId } = seedRun(600);
    const ids = testIdsOf(runId);
    expect(ids).toHaveLength(600);

    expect(setStatusBulk(database, ids, RESULT_STATUS.blocked, { comment: "env down" })).toBe(600);
    expect(runSummary(database, runId)).toEqual([{ status_id: RESULT_STATUS.blocked, total: 600 }]);
    const results = database.prepare("SELECT COUNT(*) AS total FROM results").get() as {
      total: number;
    };
    expect(results.total).toBe(600);
  });

  it("treats an imported custom status as first class", () => {
    const { runId } = seedRun(1);
    const [testId] = testIdsOf(runId);
    database
      .prepare(
        "INSERT INTO statuses (id, system_name, label, is_untested, is_final) VALUES (?, ?, ?, 0, 1)",
      )
      .run(FIRST_CUSTOM_STATUS_ID, "wont_fix", "Won't fix");

    addResult(database, { testId, statusId: FIRST_CUSTOM_STATUS_ID });
    expect(runSummary(database, runId)).toEqual([
      { status_id: FIRST_CUSTOM_STATUS_ID, total: 1 },
    ]);
    const progress = runProgress(runSummary(database, runId), listStatuses(database));
    expect(progress.executed).toBe(1);
    expect(progress.passRate).toBe(0);
  });

  it("reports a pass rate over executed tests, never over the whole run", () => {
    const { runId } = seedRun(100);
    const ids = testIdsOf(runId);
    setStatusBulk(database, ids.slice(0, 10), RESULT_STATUS.passed);
    setStatusBulk(database, ids.slice(10, 12), RESULT_STATUS.failed, { comment: "broken" });

    const progress = runProgress(runSummary(database, runId), listStatuses(database));
    expect(progress.total).toBe(100);
    expect(progress.untested).toBe(88);
    expect(progress.executed).toBe(12);
    expect(Math.round((progress.passRate ?? 0) * 100)).toBe(83);
  });

  it("has no pass rate at all before anything is executed", () => {
    const { runId } = seedRun(5);
    expect(runProgress(runSummary(database, runId), listStatuses(database)).passRate).toBeNull();
  });

  it("rolls a plan and a nested milestone up in one query each", () => {
    const projectId = createProject(database, { name: "P" });
    const suiteId = createSuite(database, { projectId, name: "S" });
    createCase(database, { suiteId, title: "only case" });
    const parent = createMilestone(database, { projectId, name: "Q1" });
    const child = createMilestone(database, { projectId, parentId: parent, name: "Sprint 1" });
    const planId = createPlan(database, { projectId, name: "Release" });

    const inPlan = createRun(database, { projectId, suiteId, name: "A", planId, milestoneId: child });
    const loose = createRun(database, { projectId, suiteId, name: "B", milestoneId: parent });
    addResult(database, {
      testId: testIdsOf(inPlan)[0],
      statusId: RESULT_STATUS.passed,
    });
    addResult(database, {
      testId: testIdsOf(loose)[0],
      statusId: RESULT_STATUS.failed,
      comment: "nope",
    });

    expect(planSummary(database, planId)).toEqual([{ status_id: RESULT_STATUS.passed, total: 1 }]);
    expect(milestoneSummary(database, child)).toEqual([
      { status_id: RESULT_STATUS.passed, total: 1 },
    ]);
    expect(milestoneSummary(database, parent).map((row) => row.total).reduce((a, b) => a + b)).toBe(2);
  });

  it("assigns without locking: anyone may record on an assigned test", () => {
    const { runId } = seedRun(2);
    const ids = testIdsOf(runId);
    const owner = createUser(database, { email: "owner@example.com", role: "tester", passwordHash: null });
    const other = createUser(database, { email: "other@example.com", role: "tester", passwordHash: null });

    expect(assignTests(database, ids, owner)).toBe(2);
    expect(() =>
      addResult(database, { testId: ids[0], statusId: RESULT_STATUS.passed, createdBy: other }),
    ).not.toThrow();

    // Reassign on result: how a failure reaches whoever will retest it.
    addResult(database, {
      testId: ids[1],
      statusId: RESULT_STATUS.failed,
      comment: "over to you",
      assignedTo: other,
      createdBy: owner,
    });
    expect(getTest(database, ids[1])?.assigned_to).toBe(other);
  });

  it("takes the run's tests and results with it when the run is deleted", () => {
    const { runId } = seedRun(2);
    setStatusBulk(database, testIdsOf(runId), RESULT_STATUS.passed);
    expect(countRunResults(database, runId)).toBe(2);

    deleteRun(database, runId);

    for (const table of ["tests", "results"]) {
      const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as {
        total: number;
      };
      expect(row.total, table).toBe(0);
    }
  });

  it("reads a page of a run's tests without sorting the whole run", () => {
    const { runId } = seedRun(30);
    const plan = database
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM tests WHERE run_id = ? ORDER BY id LIMIT ? OFFSET ?")
      .all(runId, 25, 0) as { detail: string }[];
    // 90ms a page at 100k tests when this index was missing.
    expect(plan.map((step) => step.detail).join(" ")).not.toMatch(/TEMP B-TREE/);
  });

  it("refuses a run whose suite belongs to another project", () => {
    const other = createProject(database, { name: "Elsewhere" });
    const otherSuite = createSuite(database, { projectId: other, name: "Theirs" });
    const projectId = createProject(database, { name: "Ours" });
    expect(() =>
      createRun(database, { projectId, suiteId: otherSuite, name: "cross", includeAll: true }),
    ).toThrow(/another project/i);
  });

  it("refuses a plan or a run pointing at another project's milestone", () => {
    const other = createProject(database, { name: "Elsewhere" });
    const theirMilestone = createMilestone(database, { projectId: other, name: "Theirs" });
    const projectId = createProject(database, { name: "Ours" });
    const suiteId = createSuite(database, { projectId, name: "S" });

    expect(() =>
      createPlan(database, { projectId, name: "p", milestoneId: theirMilestone }),
    ).toThrow(/another project/i);
    expect(() =>
      createRun(database, {
        projectId,
        suiteId,
        name: "r",
        includeAll: true,
        milestoneId: theirMilestone,
      }),
    ).toThrow(/another project/i);
  });

  it("refuses a run built from case ids it cannot use, instead of a short run", () => {
    const projectId = createProject(database, { name: "P" });
    const suiteId = createSuite(database, { projectId, name: "S" });
    const other = createSuite(database, { projectId, name: "Other" });
    const mine = createCase(database, { suiteId, title: "mine" });
    const theirs = createCase(database, { suiteId: other, title: "theirs" });
    const deleted = createCase(database, { suiteId, title: "deleted" });
    deleteCase(database, deleted, null);

    expect(() =>
      createRun(database, { projectId, suiteId, name: "r", caseIds: [mine, theirs] }),
    ).toThrow(/1 of 2 cases/);
    expect(() =>
      createRun(database, { projectId, suiteId, name: "r", caseIds: [mine, deleted] }),
    ).toThrow(/1 of 2 cases/);
    expect(() =>
      createRun(database, { projectId, suiteId, name: "r", caseIds: [mine] }),
    ).not.toThrow();
  });

  it("refuses includeAll and caseIds together rather than picking one", () => {
    const projectId = createProject(database, { name: "P" });
    const suiteId = createSuite(database, { projectId, name: "S" });
    const caseId = createCase(database, { suiteId, title: "c" });
    expect(() =>
      createRun(database, { projectId, suiteId, name: "r", includeAll: true, caseIds: [caseId] }),
    ).toThrow(/not both/i);
  });

  it("will not write through a run id that does not own the tests", () => {
    const { runId: first } = seedRun(1);
    const { runId: second } = seedRun(1);
    const [strayTest] = testIdsOf(first);

    expect(() =>
      setStatusBulk(database, [strayTest], RESULT_STATUS.passed, { runId: second }),
    ).toThrow(/not in run/i);
    expect(() => assignTests(database, [strayTest], null, second)).toThrow(/not in run/i);
    expect(() => assignTests(database, [strayTest], null, 9999)).toThrow(/No run with id 9999/);

    // Untouched by any of the three.
    expect(getTest(database, strayTest)?.status_id).toBe(RESULT_STATUS.untested);
  });

  it("rolls a close back when the rename in the same edit is rejected", () => {
    const { runId } = seedRun(1);
    expect(() => editRun(database, runId, { isCompleted: true, name: "x" })).not.toThrow();
    setRunCompleted(database, runId, false);

    // updateRun rejects an unknown id; here the close lands first and has to
    // come back with it.
    expect(() => editRun(database, 9999, { isCompleted: true, name: "x" })).toThrow();
    expect(getRun(database, runId)?.is_completed).toBe(0);
  });

  it("orders one transaction's worth of results deterministically", () => {
    const { runId } = seedRun(1);
    const [testId] = testIdsOf(runId);
    // Three results in one call share a timestamp, so created_on alone
    // cannot order them.
    addResultsBulk(database, [
      { testId, statusId: RESULT_STATUS.failed, comment: "one" },
      { testId, statusId: RESULT_STATUS.retest },
      { testId, statusId: RESULT_STATUS.passed },
    ]);
    const history = listResults(database, testId, {});
    expect(history.rows.map((row) => row.comment)).toEqual([null, null, "one"]);
    expect(history.rows.map((row) => row.status_id)).toEqual([
      RESULT_STATUS.passed,
      RESULT_STATUS.retest,
      RESULT_STATUS.failed,
    ]);
  });

  it("reads a milestone rollup without scanning every test in the database", () => {
    const projectId = createProject(database, { name: "P" });
    const plan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT tests.status_id, COUNT(*) FROM tests JOIN runs ON runs.id = tests.run_id
          WHERE runs.milestone_id IN (SELECT id FROM milestones WHERE project_id = ?)
          GROUP BY tests.status_id`,
      )
      .all(projectId) as { detail: string }[];
    // Without idx_runs_milestone the planner inverts the join and scans the
    // whole tests table: 2.05ms for a milestone holding three tests.
    expect(plan.map((step) => step.detail).join(" ")).not.toMatch(/SCAN tests/);
  });

  it("reads a result history without sorting its tiebreak", () => {
    const plan = database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM results WHERE test_id = ? ORDER BY created_on DESC, id DESC LIMIT ? OFFSET ?",
      )
      .all(1, 25, 0) as { detail: string }[];
    expect(plan.map((step) => step.detail).join(" ")).not.toMatch(/TEMP B-TREE/);
  });

  it("caps a bulk result call", () => {
    const { runId } = seedRun(1);
    const [testId] = testIdsOf(runId);
    const tooMany = Array.from({ length: MAX_BULK_IDS + 1 }, () => testId);
    expect(() => setStatusBulk(database, tooMany, RESULT_STATUS.passed)).toThrow(/At most/);
  });
});

describe("attachment storage", () => {
  it("never derives the stored name from what the uploader sent", () => {
    expect(storageNameFor("../../etc/passwd")).toMatch(/^[0-9a-f]{32}$/);
    expect(storageNameFor("report.png")).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(storageNameFor("sneaky.pn/../g")).toMatch(/^[0-9a-f]{32}$/);
    expect(storageNameFor("no-extension")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("elapsed time", () => {
  it("reads TestRail's format and leaves unreadable input null", () => {
    expect(parseElapsed("1m 45s")).toBe(105);
    expect(parseElapsed("2h 3m 4s")).toBe(7384);
    expect(parseElapsed("30s")).toBe(30);
    // Null, not zero: a value we failed to read must not count as no time.
    expect(parseElapsed("a while")).toBeNull();
    expect(parseElapsed("")).toBeNull();
    expect(parseElapsed(null)).toBeNull();
  });

  it("round trips through the formatter", () => {
    expect(formatElapsed(parseElapsed("1m 45s"))).toBe("1m 45s");
    expect(formatElapsed(parseElapsed("2h 3m 4s"))).toBe("2h 3m 4s");
    expect(formatElapsed(0)).toBeNull();
  });
});

describe("listUsers", () => {
  it("lists active accounts only, and never the password hash", () => {
    const activeId = seedUser("active@example.com");
    const disabledId = seedUser("disabled@example.com");
    database.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(disabledId);

    const page = listUsers(database);
    expect(page.rows.map((user) => user.id)).toEqual([activeId]);
    expect(Object.keys(page.rows[0])).toEqual(["id", "email", "name", "role"]);
  });

  it("searches email and name, and treats a wildcard as a character", () => {
    createUser(database, {
      email: "ada@example.com",
      name: "Ada Lovelace",
      role: "lead",
      passwordHash: null,
    });
    seedUser("grace@example.com");

    expect(listUsers(database, { search: "lovelace" }).rows.map((user) => user.email)).toEqual([
      "ada@example.com",
    ]);
    expect(listUsers(database, { search: "grace@" }).total).toBe(1);
    // Unescaped, this pattern would match every row in the table.
    expect(listUsers(database, { search: "%" }).total).toBe(0);
  });

  it("pages in SQL", () => {
    for (let index = 0; index < 30; index += 1) {
      seedUser(`tester${String(index).padStart(2, "0")}@example.com`);
    }
    const first = listUsers(database, { limit: 25 });
    expect(first.total).toBe(30);
    expect(first.rows).toHaveLength(25);
    expect(listUsers(database, { limit: 25, page: 2 }).rows).toHaveLength(5);
  });
});

describe("listRunsWithProgress", () => {
  function seedTwoRuns() {
    const projectId = createProject(database, { name: "Payments" });
    const suiteId = createSuite(database, { projectId, name: "API" });
    const sectionId = createSection(database, { suiteId, name: "health" });
    for (let index = 0; index < 2; index += 1) {
      createCase(database, { suiteId, sectionId, title: `Case ${index}` });
    }
    const closedRunId = createRun(database, {
      projectId,
      suiteId,
      name: "Last week",
      includeAll: true,
    });
    const openRunId = createRun(database, {
      projectId,
      suiteId,
      name: "This week",
      includeAll: true,
    });
    return { projectId, closedRunId, openRunId };
  }

  it("carries one progress bar per run, open runs first", () => {
    const { projectId, closedRunId, openRunId } = seedTwoRuns();
    const openTestId = listTests(database, openRunId, {}).rows[0].id;
    addResult(database, { testId: openTestId, statusId: RESULT_STATUS.passed, createdBy: null });
    editRun(database, closedRunId, { isCompleted: true });

    const page = listRunsWithProgress(database, { projectId });
    expect(page.rows.map((run) => run.id)).toEqual([openRunId, closedRunId]);

    const [open, closed] = page.rows;
    expect(open.progress).toMatchObject({ total: 2, executed: 1, untested: 1, passRate: 1 });
    // The second run's bar must not pick up the first run's result.
    expect(closed.progress).toMatchObject({ total: 2, executed: 0, untested: 2, passRate: null });
  });

  it("filters open and closed runs in SQL", () => {
    const { projectId, openRunId, closedRunId } = seedTwoRuns();
    editRun(database, closedRunId, { isCompleted: true });

    expect(
      listRunsWithProgress(database, { projectId, isCompleted: false }).rows.map((run) => run.id),
    ).toEqual([openRunId]);
    const closed = listRunsWithProgress(database, { projectId, isCompleted: true });
    expect(closed.rows.map((run) => run.id)).toEqual([closedRunId]);
    // The total is the filtered total, not the project's: a pager reading the
    // unfiltered count offers pages that are not there.
    expect(closed.total).toBe(1);
  });

  it("returns no rows, and no extra query, for a project with no runs", () => {
    const projectId = createProject(database, { name: "Empty" });
    expect(listRunsWithProgress(database, { projectId })).toMatchObject({ rows: [], total: 0 });
  });

  it("groups a page of runs off the covering index, with no sort", () => {
    const { closedRunId, openRunId } = seedTwoRuns();
    const plan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT run_id, status_id, COUNT(*) AS total FROM tests
          WHERE run_id IN (?, ?) GROUP BY run_id, status_id`,
      )
      .all(openRunId, closedRunId) as { detail: string }[];
    const detail = plan.map((step) => step.detail).join(" ");
    expect(detail).toMatch(/COVERING INDEX idx_tests_run/);
    expect(detail).not.toMatch(/TEMP B-TREE/);
  });
});

describe("the users list plan", () => {
  it("orders off idx_users_email rather than sorting the table", () => {
    const plan = database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id, email, name, role FROM users WHERE is_active = 1 ORDER BY email LIMIT ? OFFSET ?",
      )
      .all(25, 0) as { detail: string }[];
    expect(plan.map((step) => step.detail).join(" ")).not.toMatch(/TEMP B-TREE/);
  });
});

describe("the dashboard numbers", () => {
  function seedProjectWithResults() {
    const projectId = createProject(database, { name: "Payments" });
    const suiteId = createSuite(database, { projectId, name: "API" });
    const sectionId = createSection(database, { suiteId, name: "health" });
    for (let index = 0; index < 3; index += 1) {
      createCase(database, { suiteId, sectionId, title: `Case ${index}` });
    }
    const openRunId = createRun(database, { projectId, suiteId, name: "Open", includeAll: true });
    const closedRunId = createRun(database, { projectId, suiteId, name: "Closed", includeAll: true });
    editRun(database, closedRunId, { isCompleted: true });
    return { projectId, openRunId, closedRunId };
  }

  it("counts open runs and rolls every test in the project up in SQL", () => {
    const { projectId, openRunId } = seedProjectWithResults();
    const [firstTest, secondTest] = listTests(database, openRunId, {}).rows;
    addResult(database, { testId: firstTest.id, statusId: RESULT_STATUS.passed, createdBy: null });
    addResult(database, {
      testId: secondTest.id,
      statusId: RESULT_STATUS.failed,
      comment: "500 on an empty body",
      createdBy: null,
    });

    const overview = projectOverview(database, projectId);
    expect(overview).toMatchObject({ openRuns: 1, totalRuns: 2 });
    // Six tests across both runs; two of them executed, one passed.
    expect(overview.progress).toMatchObject({ total: 6, executed: 2, untested: 4, passRate: 0.5 });
  });

  it("reports nothing executed rather than zero percent passing", () => {
    const { projectId } = seedProjectWithResults();
    expect(projectOverview(database, projectId).progress.passRate).toBeNull();
  });

  it("keeps one project's activity out of another's", () => {
    const { projectId, openRunId } = seedProjectWithResults();
    const other = seedProjectWithResults();
    const authorId = seedUser("author@example.com");
    const [ourTest] = listTests(database, openRunId, {}).rows;
    addResult(database, {
      testId: ourTest.id,
      statusId: RESULT_STATUS.passed,
      createdBy: authorId,
    });

    const ours = recentActivity(database, projectId);
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({
      status_id: RESULT_STATUS.passed,
      run_name: "Open",
      title_snapshot: ourTest.title_snapshot,
      author: null,
    });
    expect(recentActivity(database, other.projectId)).toEqual([]);
  });

  it("bounds the feed however much the caller asks for", () => {
    const { projectId, openRunId } = seedProjectWithResults();
    const [test] = listTests(database, openRunId, {}).rows;
    for (let index = 0; index < 4; index += 1) {
      addResult(database, { testId: test.id, statusId: RESULT_STATUS.passed, createdBy: null });
    }
    expect(recentActivity(database, projectId, 2)).toHaveLength(2);
    expect(recentActivity(database, projectId, 10_000)).toHaveLength(4);
    expect(recentActivity(database, projectId, 0)).toHaveLength(4);
  });

  /*
    The feed's ORDER BY, on its own. The joined plan is stats-dependent - on an
    empty database the planner starts from runs and sorts, with 5,000 results
    and ANALYZE it walks idx_results_recent newest-first and stops at the limit
    (1.9ms to 0.1ms). What must not change is that the index exists and the
    ordering can ride it, which is what this pins.
  */
  it("keeps an index the activity feed's ordering can ride", () => {
    const plan = database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM results ORDER BY created_on DESC, id DESC LIMIT ?",
      )
      .all(10) as { detail: string }[];
    const detail = plan.map((step) => step.detail).join(" ");
    expect(detail).toMatch(/idx_results_recent/);
    expect(detail).not.toMatch(/TEMP B-TREE/);
  });
});
