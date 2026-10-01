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
  listProjects,
  moveSection,
  sectionTree,
  updateCase,
  upsertCaseField,
} from "./db";
import { CASE_PRIORITY, CASE_TYPE, MAX_SECTION_LEVELS, RESULT_STATUS } from "./format";

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
    const second = upsertCaseField(database, {
      systemName: "platform",
      label: "Platform",
      type: "dropdown",
      configs: JSON.stringify({ options: { items: ["API"] } }),
    });
    expect(second).toBe(first);
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
