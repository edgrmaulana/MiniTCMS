import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  createCase,
  createProject,
  createSuite,
  getImportRun,
  listCaseFields,
  listResults,
  listStatuses,
  listTests,
  openDb,
  runSummary,
  sectionTree,
} from "../db";
import type { TestRailClient } from "../testrail";
import { runApiImport } from "./run";
import { reconcile } from "./report";
import { CASE_PRIORITY, CASE_TEMPLATE, CASE_TYPE, RESULT_STATUS } from "../format";

/*
  A real-shaped instance with every name and email replaced. Children are
  listed before their parents on purpose: TestRail does not promise an order
  and the importer has to sort that out itself.
*/
function instance(): Record<string, unknown> {
  return {
    get_users: [
      { id: 1, email: "ana@example.com", name: "Ana", is_active: true },
      { id: 2, email: "bo@example.com", name: "Bo", is_active: false },
    ],
    get_statuses: [
      { id: 1, name: "passed", label: "Passed", is_untested: false, is_final: true },
      { id: 2, name: "blocked", label: "Blocked", is_untested: false, is_final: true },
      { id: 3, name: "untested", label: "Untested", is_untested: true, is_final: false },
      { id: 4, name: "retest", label: "Retest", is_untested: false, is_final: false },
      { id: 5, name: "failed", label: "Failed", is_untested: false, is_final: true },
      {
        id: 6,
        name: "needs_review",
        label: "Needs review",
        is_untested: false,
        is_final: false,
        color_dark: 0x37b9d8,
      },
    ],
    get_case_fields: [
      {
        id: 1,
        type_id: 6,
        system_name: "custom_business_unit",
        label: "Business Unit",
        configs: [{ options: { items: "1, Retail\n2, Wholesale" } }],
      },
      { id: 2, type_id: 99, system_name: "custom_mystery", label: "Mystery" },
    ],
    get_priorities: [
      { id: 1, name: "Low" },
      { id: 2, name: "Medium" },
      { id: 9, name: "Urgent" },
    ],
    get_case_types: [
      { id: 7, name: "Other" },
      { id: 3, name: "Smoke & Sanity" },
    ],
    get_templates: [
      { id: 1, name: "Test Case (Text)" },
      { id: 2, name: "Test Case (Steps)" },
    ],
    get_projects: [
      { id: 10, name: "Payments", announcement: "read me", suite_mode: 1, is_completed: false },
    ],
    "get_suites/10": [{ id: 20, name: "api", description: "the api suite", is_baseline: false }],
    "get_milestones/10": [
      { id: 31, name: "Child milestone", parent_id: 30, is_completed: false, start_on: 1700000000 },
      { id: 30, name: "Parent milestone", parent_id: null, due_on: 1700500000 },
    ],
    "get_sections/10": [
      { id: 41, name: "Leaf", parent_id: 40, depth: 1, display_order: 1 },
      { id: 40, name: "Root", parent_id: null, depth: 0, display_order: 0 },
    ],
    "get_cases/10": [
      {
        id: 50,
        title: "Health check reports connected",
        section_id: 41,
        template_id: 1,
        type_id: 7,
        priority_id: 2,
        refs: "TICKET-1",
        estimate: "30s",
        milestone_id: 30,
        created_by: 1,
        created_on: 1700000000,
        updated_by: 2,
        updated_on: 1700000100,
        custom_business_unit: "Retail",
        custom_steps: "send the request",
        custom_steps_separated: [{ content: "call /health", expected: "200" }],
        custom_mystery: "",
      },
      {
        id: 51,
        title: "Priority nobody mapped",
        section_id: 40,
        template_id: 1,
        type_id: 3,
        priority_id: 9,
        created_on: 1700000000,
      },
    ],
    "get_plans/10": [
      { id: 60, name: "Release 1", milestone_id: 30, is_completed: false, created_on: 1700000000 },
    ],
    "get_plan/60": {
      entries: [
        {
          runs: [
            { id: 71, name: "Plan run", suite_id: 20, plan_id: 60, include_all: true, created_on: 1700000200 },
          ],
        },
      ],
    },
    "get_runs/10": [
      {
        id: 70,
        name: "Standalone run",
        suite_id: 20,
        milestone_id: 31,
        include_all: true,
        config: "Chrome, Windows",
        created_on: 1700000100,
      },
    ],
    "get_tests/70": [
      { id: 80, case_id: 50, title: "Health check reports connected", status_id: 1, assignedto_id: 1 },
    ],
    "get_tests/71": [{ id: 81, case_id: 51, title: "Priority nobody mapped", status_id: 6 }],
    "get_results_for_run/70": [
      {
        id: 90,
        test_id: 80,
        status_id: 1,
        comment: "looked fine",
        elapsed: "1m 45s",
        version: "2.1.0",
        defects: "TICKET-9",
        created_by: 1,
        created_on: 1700000300,
        custom_extra: "kept verbatim",
      },
    ],
    "get_results_for_run/71": [],
  };
}

type Fake = {
  client: TestRailClient;
  calls: string[];
  /* The query parameters each method was last called with, so a test can
     assert on the request and not only on what came back. */
  params: Record<string, Record<string, string | number> | undefined>;
};

function fakeClient(data: Record<string, unknown>): Fake {
  const calls: string[] = [];
  const params: Fake["params"] = {};
  const answer = (method: string, query?: Record<string, string | number>): unknown => {
    calls.push(method);
    params[method] = query;
    return data[method];
  };
  const client: TestRailClient = {
    async get<Response>(method: string, query?: Record<string, string | number>) {
      const body = answer(method, query);
      if (body === undefined) throw new Error(`no fixture for ${method}`);
      return body as Response;
    },
    async getAll<Row>(
      method: string,
      _collection: string,
      query?: Record<string, string | number>,
    ) {
      const body = answer(method, query);
      return (Array.isArray(body) ? body : []) as Row[];
    },
  };
  return { client, calls, params };
}

let directory: string;
let database: Database.Database;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "minitcms-api-"));
  database = openDb(join(directory, "test.db"));
});

afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("api import", () => {
  it("imports an instance top to bottom and reconciles", async () => {
    const { client } = fakeClient(instance());
    const { report } = await runApiImport(database, client);

    expect(reconcile(report)).toEqual([]);
    expect(report.counts.projects).toMatchObject({ fetched: 1, inserted: 1 });
    expect(report.counts.suites).toMatchObject({ fetched: 1, inserted: 1 });
    expect(report.counts.milestones).toMatchObject({ fetched: 2, inserted: 2 });
    expect(report.counts.sections).toMatchObject({ fetched: 2, inserted: 2 });
    expect(report.counts.cases).toMatchObject({ fetched: 2, inserted: 2 });
    expect(report.counts.plans).toMatchObject({ fetched: 1, inserted: 1 });
    expect(report.counts.runs).toMatchObject({ fetched: 2, inserted: 2 });
    expect(report.counts.tests).toMatchObject({ fetched: 2, inserted: 2 });
    expect(report.counts.results).toMatchObject({ fetched: 1, inserted: 1 });
  });

  it("writes nested rows parents-first however they arrive", async () => {
    const { client } = fakeClient(instance());
    await runApiImport(database, client);

    const suiteId = (database.prepare("SELECT id FROM suites").get() as { id: number }).id;
    expect(sectionTree(database, suiteId).map((node) => [node.name, node.depth])).toEqual([
      ["Root", 0],
      ["Leaf", 1],
    ]);
    const child = database
      .prepare("SELECT parent_id FROM milestones WHERE source_id = 31")
      .get() as { parent_id: number };
    const parent = database.prepare("SELECT id FROM milestones WHERE source_id = 30").get() as {
      id: number;
    };
    expect(child.parent_id).toBe(parent.id);
  });

  it("keeps the second pass empty", async () => {
    const { client } = fakeClient(instance());
    await runApiImport(database, client);
    const { report } = await runApiImport(database, fakeClient(instance()).client);

    for (const entity of [
      "users",
      "case_fields",
      "projects",
      "suites",
      "sections",
      "cases",
      "plans",
      "runs",
      "tests",
      "results",
    ] as const) {
      expect(report.counts[entity], entity).toMatchObject({ inserted: 0, updated: 0 });
    }
    expect(reconcile(report)).toEqual([]);
  });

  it("translates labels and keeps the custom bag verbatim", async () => {
    const { client } = fakeClient(instance());
    const { report } = await runApiImport(database, client);

    const health = database.prepare("SELECT * FROM cases WHERE source_id = 50").get() as {
      priority_id: number | null;
      type_id: number | null;
      template_id: number;
      custom: string;
      estimate: string;
      refs: string;
    };
    expect(health.priority_id).toBe(CASE_PRIORITY.medium);
    expect(health.type_id).toBe(CASE_TYPE.other);
    expect(health.template_id).toBe(CASE_TEMPLATE.text);
    expect(health.refs).toBe("TICKET-1");
    expect(JSON.parse(health.custom)).toEqual({
      business_unit: "Retail",
      steps_text: "send the request",
      steps: [{ content: "call /health", expected: "200" }],
    });

    const unmapped = database.prepare("SELECT * FROM cases WHERE source_id = 51").get() as {
      priority_id: number | null;
      type_id: number | null;
    };
    expect(unmapped.priority_id).toBeNull();
    expect(unmapped.type_id).toBeNull();
    expect(
      report.unmapped.some((entry) => entry.value.includes("Urgent")),
    ).toBe(true);
    expect(
      report.unmapped.some((entry) => entry.value.includes("Smoke & Sanity")),
    ).toBe(true);
  });

  it("imports a custom status and lets a test hold it", async () => {
    const { client } = fakeClient(instance());
    await runApiImport(database, client);

    const custom = listStatuses(database).find((status) => status.id === 6);
    expect(custom).toMatchObject({ system_name: "needs_review", label: "Needs review" });
    expect(custom?.color).toBe("#37b9d8");

    const planRun = database.prepare("SELECT id FROM runs WHERE source_id = 71").get() as {
      id: number;
    };
    expect(runSummary(database, planRun.id)).toEqual([{ status_id: 6, total: 1 }]);
  });

  it("keeps a result's elapsed string and its own custom fields", async () => {
    const { client } = fakeClient(instance());
    await runApiImport(database, client);

    const testId = (database.prepare("SELECT id FROM tests WHERE source_id = 80").get() as {
      id: number;
    }).id;
    const history = listResults(database, testId, { limit: 25 });
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0].elapsed).toBe("1m 45s");
    expect(history.rows[0].status_id).toBe(RESULT_STATUS.passed);
    expect(JSON.parse(history.rows[0].custom ?? "{}")).toEqual({ extra: "kept verbatim" });
  });

  it("claims an existing local account by email instead of inserting a second one", async () => {
    database
      .prepare("INSERT INTO users (email, name, role, created_on) VALUES (?, ?, ?, ?)")
      .run("ana@example.com", "Ana Existing", "admin", 1600000000);
    const { client } = fakeClient(instance());
    await runApiImport(database, client);

    const rows = database.prepare("SELECT email, role, source FROM users ORDER BY email").all() as {
      email: string;
      role: string;
      source: string | null;
    }[];
    expect(rows).toHaveLength(2);
    // The claim stamps the source and must not demote an existing admin.
    expect(rows[0]).toMatchObject({ email: "ana@example.com", role: "admin", source: "testrail" });
  });

  it("reports a field type it does not know and still keeps the definition", async () => {
    const { client } = fakeClient(instance());
    const { report } = await runApiImport(database, client);

    const mystery = listCaseFields(database).find((field) => field.system_name === "mystery");
    expect(mystery?.type).toBe("testrail_99");
    expect(report.unmapped.some((entry) => entry.entity === "case_fields")).toBe(true);
  });

  it("fails loud on a result whose status was never imported", async () => {
    const data = instance();
    (data["get_results_for_run/70"] as Record<string, unknown>[])[0].status_id = 77;
    const { client } = fakeClient(data);
    await expect(runApiImport(database, client)).rejects.toThrow(/status 77/);
    expect(getImportRun(database, 1)?.state).toBe("failed");
  });

  it("fails loud on a section whose parent is in no export", async () => {
    const data = instance();
    data["get_sections/10"] = [{ id: 41, name: "Orphan", parent_id: 999, depth: 1 }];
    const { client } = fakeClient(data);
    await expect(runApiImport(database, client)).rejects.toThrow(/parent that is not in this export/);
  });

  it("writes nothing on a dry run", async () => {
    const { client } = fakeClient(instance());
    const { report } = await runApiImport(database, client, { dryRun: true });

    expect(report.counts.cases).toMatchObject({ inserted: 2 });
    expect(database.prepare("SELECT COUNT(*) AS total FROM cases").get()).toEqual({ total: 0 });
    expect(database.prepare("SELECT COUNT(*) AS total FROM results").get()).toEqual({ total: 0 });
    // The import_runs row survives the rollback it describes.
    expect(getImportRun(database, 1)?.state).toBe("done");
  });

  it("imports only the project it was asked for", async () => {
    const data = instance();
    (data.get_projects as Record<string, unknown>[]).push({ id: 11, name: "Other", suite_mode: 1 });
    const { client } = fakeClient(data);
    await runApiImport(database, client, { projectSourceIds: [10] });
    expect(database.prepare("SELECT COUNT(*) AS total FROM projects").get()).toEqual({ total: 1 });
  });

  it("refuses a project id that is not on the instance", async () => {
    const { client } = fakeClient(instance());
    await expect(runApiImport(database, client, { projectSourceIds: [999] })).rejects.toThrow(
      /None of the requested projects/,
    );
  });

  it("refuses a project the CSV import already filled", async () => {
    const projectId = createProject(database, { name: "Payments" });
    const suiteId = createSuite(database, { projectId, name: "csv suite" });
    const caseId = createCase(database, { suiteId, title: "from the csv" });
    database
      .prepare("UPDATE cases SET source = 'testrail-csv', source_id = 1 WHERE id = ?")
      .run(caseId);
    // The project row itself has to be the one the import resolves to.
    database.prepare("UPDATE projects SET source = 'testrail', source_id = 10 WHERE id = ?").run(projectId);

    const { client } = fakeClient(instance());
    await expect(runApiImport(database, client)).rejects.toThrow(/another source/);
  });

  it("resumes without re-reading the stages that already landed", async () => {
    const data = instance();
    const broken = fakeClient(data);
    const original = broken.client.getAll;
    let cases = 0;
    broken.client.getAll = (async (method: string, collection: string, params?: unknown) => {
      if (method === "get_cases/10") {
        cases += 1;
        throw new Error("connection reset");
      }
      return original.call(broken.client, method, collection, params as never);
    }) as TestRailClient["getAll"];

    await expect(runApiImport(database, broken.client)).rejects.toThrow("connection reset");
    expect(cases).toBe(1);

    const resumed = fakeClient(data);
    const { report } = await runApiImport(database, resumed.client, { resumeFrom: 1 });

    expect(resumed.calls).not.toContain("get_users");
    expect(resumed.calls).not.toContain("get_sections/10");
    expect(resumed.calls).toContain("get_cases/10");
    expect(reconcile(report)).toEqual([]);
    expect(database.prepare("SELECT COUNT(*) AS total FROM cases").get()).toEqual({ total: 2 });
    expect(listTests(database, (database.prepare("SELECT id FROM runs WHERE source_id = 70").get() as { id: number }).id, {}).total).toBe(1);
  });

  it("refuses to resume a finished import", async () => {
    const { client } = fakeClient(instance());
    await runApiImport(database, client);
    await expect(
      runApiImport(database, fakeClient(instance()).client, { resumeFrom: 1 }),
    ).rejects.toThrow(/already finished/);
  });
});

/*
  Plan assertions, not timings: a widened index is easy to narrow again by
  accident, and the symptom is a list that quietly starts sorting the whole
  table on every page. Both of these were measured at 200k cases and 5000
  import runs before the index was added.
*/
describe("query plans", () => {
  const planFor = (sql: string, ...params: unknown[]): string =>
    (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
      .map((row) => row.detail)
      .join(" | ");

  it("lists import runs without sorting the table", () => {
    const plan = planFor(
      "SELECT * FROM import_runs ORDER BY started_on DESC, id DESC LIMIT ? OFFSET ?",
      25,
      0,
    );
    expect(plan).not.toMatch(/TEMP B-TREE/);
    expect(plan).toMatch(/idx_import_runs_recent/);
  });

  it("resolves a display name through an index, not a scan", () => {
    const plan = planFor("SELECT id FROM users WHERE lower(name) = lower(?) LIMIT 2", "Ana");
    expect(plan).not.toMatch(/SCAN users/);
    expect(plan).toMatch(/idx_users_name_lower/);
  });

  it("probes an imported row through the source index", () => {
    const plan = planFor("SELECT id FROM cases WHERE source = ? AND source_id = ?", "testrail", 1);
    expect(plan).toMatch(/idx_cases_source/);
    expect(plan).not.toMatch(/SCAN/);
  });
});

/* Defects this pipeline shipped with once, each reproduced before the fix. */
describe("api import regressions", () => {
  const bare = (): Record<string, unknown> => ({
    get_users: [],
    get_statuses: [],
    get_case_fields: [],
    get_priorities: [],
    get_case_types: [],
    get_templates: [{ id: 1, name: "Test Case (Text)" }],
    get_projects: [{ id: 10, name: "Payments", suite_mode: 1 }],
    "get_suites/10": [{ id: 20, name: "api" }],
    "get_milestones/10": [],
    "get_sections/10": [],
    "get_cases/10": [{ id: 50, title: "TestRail sent no dates", template_id: 1 }],
    "get_plans/10": [],
    "get_runs/10": [],
  });

  /*
    A case whose source row carries no created_on fell back to the clock,
    so it differed from itself on the next import and its dates walked
    forward every time.
  */
  it("does not rewrite timestamps for a row the source sent no dates for", async () => {
    await runApiImport(database, fakeClient(bare()).client);
    const first = database
      .prepare("SELECT created_on, updated_on FROM cases WHERE source_id = 50")
      .get() as { created_on: number; updated_on: number };

    const { report } = await runApiImport(database, fakeClient(bare()).client);
    const after = database
      .prepare("SELECT created_on, updated_on FROM cases WHERE source_id = 50")
      .get() as { created_on: number; updated_on: number };

    expect(report.counts.cases).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(after).toEqual(first);
  });

  /*
    TestRail documents suite_id as optional in single-suite mode and
    rejects the call outright on some versions when it is sent anyway.
    Single suite is its default, so this would have broken most instances.
  */
  it("omits suite_id for a single-suite project and sends it otherwise", async () => {
    const single = fakeClient(bare());
    await runApiImport(database, single.client);
    expect(single.params["get_cases/10"]).toEqual({ limit: 250 });

    const multi = fakeClient({ ...bare(), get_projects: [{ id: 10, name: "P", suite_mode: 3 }] });
    await runApiImport(database, multi.client);
    expect(multi.params["get_cases/10"]).toEqual({ limit: 250, suite_id: 20 });
  });

  /*
    A TestRail result with no status is a comment-only row. It is kept,
    but it is the one place a result holds untested - which everywhere else
    means "no result exists" - so it must not land silently.
  */
  it("reports a comment-only result rather than filing it as untested in silence", async () => {
    const data = instance();
    delete (data["get_results_for_run/70"] as Record<string, unknown>[])[0].status_id;
    const { report } = await runApiImport(database, fakeClient(data).client);

    expect(
      report.unmapped.some(
        (entry) => entry.entity === "results" && entry.value.includes("comment-only"),
      ),
    ).toBe(true);
  });
});
