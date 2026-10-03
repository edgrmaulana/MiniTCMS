import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  createCase,
  createProject,
  createSection,
  createSuite,
  createUser,
  listCaseFields,
  listCases,
  listImportRuns,
  openDb,
  sectionTree,
} from "../db";
import { parseCsv, readCsvCases } from "./csv";
import { importCsv, runCsvImport } from "./import-csv";
import { MappingError, parseUserMap } from "./map";
import { type ImportReport, emptyReport, reconcile } from "./report";
import { CASE_PRIORITY, CASE_TYPE, MAX_SECTION_LEVELS } from "../format";

/*
  The fixture is written by hand from the format facts measured on a real
  export (plan section 6.1). A real customer export is never committed: it
  carries live endpoints, traffic volumes and staff names, and this repo is
  public.
*/
const HEADER = [
  "ID",
  "Title",
  "Attachments",
  "Business_Unit",
  "Created By",
  "Created On",
  "Estimate",
  "Expected Result",
  "Preconditions",
  "Priority",
  "Section",
  "Section Depth",
  "Section Hierarchy",
  "Steps",
  "Steps",
  "Suite",
  "Suite ID",
  "Template",
  "Type",
  "Updated By",
  "Updated On",
];

type Cell = Record<string, string>;

function row(values: Cell): string[] {
  return HEADER.map((name, index) => values[`${name}#${index}`] ?? values[name] ?? "");
}

// CRLF and RFC 4180 quoting, the way the real export writes them.
function toCsv(rows: string[][]): string {
  return rows
    .map((cells) => cells.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
}

const BASE: Cell = {
  "Created By": "ana",
  "Created On": "10/1/2026 6:26 PM",
  "Updated By": "ana",
  "Updated On": "10/1/2026 6:26 PM",
  Suite: "billing-service",
  "Suite ID": "S928",
  Template: "Test Case (Text)",
  Type: "Other",
  Priority: "Medium",
};

function sampleFile(extra: Cell[] = []): string {
  const rows = [
    HEADER,
    row({
      ...BASE,
      ID: "C101",
      Title: 'Health check reports "connected", twice\r\nand wraps a line',
      "Business_Unit": "Northern Division",
      Preconditions: "1. Base URL set\r\n2. No authentication",
      "Expected Result": '200\r\n{\r\n    "success": true\r\n}',
      Section: "GET Health Check",
      "Section Depth": "2",
      "Section Hierarchy": "billing-service > Health > GET Health Check",
      "Steps#13": "send the request",
      "Steps#14": "second steps column",
    }),
    row({
      ...BASE,
      ID: "C102",
      Title: "Negative - database unreachable",
      Priority: "Urgent",
      Type: "Smoke & Sanity",
      Attachments: "screenshot.png",
      Section: "Health",
      "Section Depth": "1",
      "Section Hierarchy": "billing-service > Health",
    }),
    row({
      ...BASE,
      ID: "C103",
      Title: "Root level case",
      Section: "billing-service",
      "Section Depth": "0",
      "Section Hierarchy": "billing-service",
    }),
    ...extra.map((cell) => row({ ...BASE, ...cell })),
  ];
  return toCsv(rows);
}

const OPTIONS = { dateOrder: "mdy", timeZone: "Asia/Jakarta" } as const;

describe("parseCsv", () => {
  it("keeps a quoted field with a CRLF, a comma and a doubled quote as one value", () => {
    const rows = parseCsv('"a","line one\r\nline two, with comma and ""quotes"""\r\n"b","c"');
    expect(rows).toHaveLength(2);
    expect(rows[0][1]).toBe('line one\r\nline two, with comma and "quotes"');
    expect(rows[1]).toEqual(["b", "c"]);
  });

  it("reads a bare LF file and a trailing newline", () => {
    expect(parseCsv("a,b\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("strips a byte order mark", () => {
    expect(parseCsv('﻿"ID"')[0][0]).toBe("ID");
  });

  it("returns no rows for an empty file", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("readCsvCases", () => {
  it("keeps both columns when a header name repeats", () => {
    const report = emptyReport("testrail-csv");
    const { cases, fields } = readCsvCases(sampleFile(), OPTIONS, report);
    const names = fields.map((field) => field.systemName);
    expect(names).toContain("steps_text");
    expect(names).toContain("steps_text_2");
    expect(cases[0].custom.steps_text).toBe("send the request");
    expect(cases[0].custom.steps_text_2).toBe("second steps column");
  });

  it("maps TestRail's text-template fields to the names phase 2 already uses", () => {
    const report = emptyReport("testrail-csv");
    const { cases } = readCsvCases(sampleFile(), OPTIONS, report);
    expect(cases[0].custom.preconds).toContain("Base URL");
    expect(cases[0].custom.expected).toContain('"success": true');
    expect(cases[0].custom.business_unit).toBe("Northern Division");
  });

  it("imports an unknown priority as NULL with one unmapped line, not as other", () => {
    const report = emptyReport("testrail-csv");
    const { cases } = readCsvCases(sampleFile(), OPTIONS, report);
    const negative = cases.find((draft) => draft.sourceId === 102);
    expect(negative?.priorityId).toBeNull();
    expect(negative?.typeId).toBeNull();
    expect(report.unmapped).toContainEqual({
      entity: "cases",
      sourceId: 102,
      field: "Priority",
      value: "Urgent",
    });
  });

  it("skips an attachment cell loudly and still reads the case", () => {
    const report = emptyReport("testrail-csv");
    const { cases } = readCsvCases(sampleFile(), OPTIONS, report);
    expect(cases.map((draft) => draft.sourceId)).toContain(102);
    expect(report.skipped[0]).toMatchObject({ entity: "attachments", sourceId: 102 });
  });

  it("names the case when the section depth disagrees with the path", () => {
    const file = sampleFile([
      { ID: "C104", Title: "Bad depth", Section: "Leaf", "Section Depth": "4", "Section Hierarchy": "a > Leaf" },
    ]);
    expect(() => readCsvCases(file, OPTIONS, emptyReport("x"))).toThrow(/C104/);
  });

  it("rejects a path deeper than the schema allows", () => {
    const file = sampleFile([
      {
        ID: "C105",
        Title: "Too deep",
        Section: `s${MAX_SECTION_LEVELS}`,
        "Section Depth": String(MAX_SECTION_LEVELS),
        "Section Hierarchy": Array.from(
          { length: MAX_SECTION_LEVELS + 1 },
          (_, index) => `s${index}`,
        ).join(" > "),
      },
    ]);
    expect(() => readCsvCases(file, OPTIONS, emptyReport("x"))).toThrow(/levels deep/);
  });

  it("refuses a file whose ids repeat", () => {
    const file = sampleFile([{ ID: "C101", Title: "Same id again", Section: "a", "Section Depth": "0", "Section Hierarchy": "a" }]);
    expect(() => readCsvCases(file, OPTIONS, emptyReport("x"))).toThrow(/C101/);
  });

  it("refuses a steps-template export rather than reading half of it", () => {
    const header = [...HEADER, "Steps (Step)"];
    const file = toCsv([
      header,
      [...row({ ...BASE, ID: "C110", Title: "One", Section: "a", "Section Depth": "0", "Section Hierarchy": "a" }), "click the button"],
    ]);
    expect(() => readCsvCases(file, OPTIONS, emptyReport("x"))).toThrow(/Steps \(Step\)/);
  });

  it("accepts a steps column that is present but empty", () => {
    const header = [...HEADER, "Steps (Step)"];
    const file = toCsv([
      header,
      [...row({ ...BASE, ID: "C111", Title: "One", Section: "a", "Section Depth": "0", "Section Hierarchy": "a" }), ""],
    ]);
    expect(readCsvCases(file, OPTIONS, emptyReport("x")).cases).toHaveLength(1);
  });

  it("names the columns it cannot do without", () => {
    const file = toCsv([["Title", "Priority"], ["a", "Medium"]]);
    expect(() => readCsvCases(file, OPTIONS, emptyReport("x"))).toThrow(/ID, Suite, Suite ID, Template/);
  });

  it("refuses an empty file", () => {
    expect(() => readCsvCases("", OPTIONS, emptyReport("x"))).toThrow(MappingError);
  });
});

describe("importCsv", () => {
  let directory: string;
  let database: Database.Database;
  let projectId: number;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "minitcms-csv-"));
    database = openDb(join(directory, "test.db"));
    projectId = createProject(database, { name: "Payments" });
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const run = (file = sampleFile(), extra: Partial<Parameters<typeof importCsv>[2]> = {}) =>
    importCsv(database, file, {
      projectId,
      dateOrder: "mdy",
      timeZone: "Asia/Jakarta",
      ...extra,
    });

  it("builds the section tree parents-first from the path", () => {
    run();
    const suiteId = (database.prepare("SELECT id FROM suites").get() as { id: number }).id;
    const tree = sectionTree(database, suiteId);
    expect(tree.map((node) => [node.name, node.depth])).toEqual([
      ["billing-service", 0],
      ["Health", 1],
      ["GET Health Check", 2],
    ]);
  });

  it("writes every case under its own section", () => {
    const report = run();
    const suiteId = (database.prepare("SELECT id FROM suites").get() as { id: number }).id;
    const cases = listCases(database, suiteId, { limit: 100 });
    expect(cases.total).toBe(3);
    expect(report.counts.cases).toMatchObject({ fetched: 3, inserted: 3, updated: 0, unchanged: 0 });
    const health = cases.rows.find((row) => row.source_id === 101);
    expect(health?.title).toContain("twice");
    expect(JSON.parse(health?.custom ?? "{}")).toMatchObject({ business_unit: "Northern Division" });
    expect(health?.priority_id).toBe(CASE_PRIORITY.medium);
    expect(health?.type_id).toBe(CASE_TYPE.other);
  });

  it("imports twice with nothing to write the second time", () => {
    run();
    const second = run();
    expect(second.counts.cases).toMatchObject({ fetched: 3, inserted: 0, updated: 0, unchanged: 3 });
    expect(second.counts.sections).toMatchObject({ fetched: 3, inserted: 0, unchanged: 3 });
    expect(second.counts.suites).toMatchObject({ fetched: 1, inserted: 0, unchanged: 1 });
    expect(second.counts.case_fields).toMatchObject({ fetched: 5, inserted: 0, unchanged: 5 });
    expect(reconcile(second)).toEqual([]);
  });

  it("updates a case whose title changed and leaves the others alone", () => {
    run();
    const changed = sampleFile().replace("Root level case", "Root level case, renamed");
    const second = run(changed);
    expect(second.counts.cases).toMatchObject({ inserted: 0, updated: 1, unchanged: 2 });
  });

  it("stores dates in the zone the operator named", () => {
    run();
    const created = (
      database.prepare("SELECT created_on FROM cases WHERE source_id = 101").get() as {
        created_on: number;
      }
    ).created_on;
    expect(created).toBe(Date.UTC(2026, 9, 1, 11, 26) / 1000);
  });

  it("declares every custom column as a text field", () => {
    run();
    const fields = listCaseFields(database).filter((field) => field.source === "testrail-csv");
    expect(fields.map((field) => field.system_name).sort()).toEqual([
      "business_unit",
      "expected",
      "preconds",
      "steps_text",
      "steps_text_2",
    ]);
    expect(fields.every((field) => field.type === "text")).toBe(true);
  });

  it("resolves a display name only when it matches exactly one user", () => {
    createUser(database, { email: "ana@example.com", name: "ana", role: "tester", passwordHash: null });
    const report = run();
    const createdBy = (
      database.prepare("SELECT created_by FROM cases WHERE source_id = 101").get() as {
        created_by: number | null;
      }
    ).created_by;
    expect(createdBy).not.toBeNull();
    expect(report.unmapped.filter((entry) => entry.field === "Created By")).toEqual([]);
  });

  it("leaves an ambiguous name NULL and reports it once", () => {
    createUser(database, { email: "e1@example.com", name: "ana", role: "tester", passwordHash: null });
    createUser(database, { email: "e2@example.com", name: "Ana", role: "tester", passwordHash: null });
    const report = run();
    const rows = database.prepare("SELECT created_by FROM cases").all() as {
      created_by: number | null;
    }[];
    expect(rows.every((row) => row.created_by === null)).toBe(true);
    expect(report.unmapped.filter((entry) => entry.field === "Created By")).toHaveLength(1);
  });

  it("takes the operator's name=email override over a name match", () => {
    createUser(database, { email: "other@example.com", name: "ana", role: "tester", passwordHash: null });
    const wanted = createUser(database, { email: "real@example.com", name: "Ana Mendes", role: "lead", passwordHash: null });
    run(sampleFile(), { userMap: parseUserMap("ana=real@example.com") });
    const createdBy = (
      database.prepare("SELECT created_by FROM cases WHERE source_id = 101").get() as {
        created_by: number | null;
      }
    ).created_by;
    expect(createdBy).toBe(wanted);
  });

  it("writes nothing on a dry run but reports what it would have written", () => {
    const report = run(sampleFile(), { dryRun: true });
    expect(report.counts.cases).toMatchObject({ fetched: 3, inserted: 3 });
    expect(database.prepare("SELECT COUNT(*) AS total FROM cases").get()).toEqual({ total: 0 });
    expect(database.prepare("SELECT COUNT(*) AS total FROM sections").get()).toEqual({ total: 0 });
  });

  it("refuses a project that already holds cases from the API import", () => {
    const suiteId = createSuite(database, { projectId, name: "api suite" });
    database
      .prepare("UPDATE suites SET source = 'testrail', source_id = 1 WHERE id = ?")
      .run(suiteId);
    const caseId = createCase(database, { suiteId, title: "already here" });
    database.prepare("UPDATE cases SET source = 'testrail', source_id = 1 WHERE id = ?").run(caseId);

    expect(() => run()).toThrow(/already holds cases from another source/);
    expect(() => run(sampleFile(), { allowMixedSources: true })).not.toThrow();
  });

  it("refuses a time zone it cannot resolve", () => {
    expect(() => run(sampleFile(), { timeZone: "Mars/Olympus" })).toThrow(/time zone/);
  });

  it("refuses a project that does not exist", () => {
    expect(() => run(sampleFile(), { projectId: 9999 })).toThrow(/No project/);
  });

  it("reconciles every entity it touched", () => {
    const report = run();
    expect(reconcile(report)).toEqual([]);
  });
});

/*
  Every case here is a defect this file shipped with once. Each was
  reproduced before it was fixed.
*/
describe("importCsv regressions", () => {
  let directory: string;
  let database: Database.Database;
  let projectId: number;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "minitcms-csv-reg-"));
    database = openDb(join(directory, "test.db"));
    projectId = createProject(database, { name: "Payments" });
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const MINIMAL = ["ID", "Title", "Suite", "Suite ID", "Template", "Section", "Section Depth", "Section Hierarchy"];

  const minimalFile = (rows: string[][]) =>
    toCsv([MINIMAL, ...rows]);

  const importIt = (file: string) =>
    importCsv(database, file, { projectId, dateOrder: "mdy", timeZone: "UTC" });

  /*
    An export without the "Created On" column fell back to the clock, so
    every case differed from itself on the next import: 243 rows reported
    "updated" and every stored timestamp walked forward.
  */
  it("does not rewrite timestamps when the export carries no dates", () => {
    const file = minimalFile([
      ["C101", "No dates on this one", "api", "S928", "Test Case (Text)", "Root", "0", "Root"],
    ]);
    importIt(file);
    const first = database
      .prepare("SELECT created_on, updated_on FROM cases WHERE source_id = 101")
      .get() as { created_on: number; updated_on: number };

    const second = importIt(file);
    const after = database
      .prepare("SELECT created_on, updated_on FROM cases WHERE source_id = 101")
      .get() as { created_on: number; updated_on: number };

    expect(second.counts.cases).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(after).toEqual(first);
  });

  /*
    TestRail allows two sibling sections with the same name, and the
    importer keys sections on their resolved path. Without an order on the
    read, which of the two a case was filed under was whatever SQLite
    returned.
  */
  it("files a case under the same one of two same-named sections every time", () => {
    const suiteId = createSuite(database, { projectId, name: "dupes" });
    database
      .prepare("UPDATE suites SET source = 'testrail-csv', source_id = 777 WHERE id = ?")
      .run(suiteId);
    const oldest = createSection(database, { suiteId, name: "Health" });
    createSection(database, { suiteId, name: "Health" });

    const file = minimalFile([
      ["C201", "Lands in exactly one", "dupes", "S777", "Test Case (Text)", "Health", "0", "Health"],
    ]);
    importIt(file);
    const landed = database.prepare("SELECT section_id FROM cases WHERE source_id = 201").get() as {
      section_id: number;
    };
    expect(landed.section_id).toBe(oldest);

    const second = importIt(file);
    expect(second.counts.cases).toMatchObject({ updated: 0, unchanged: 1 });
  });

  /*
    The path key used to be the segments joined with a newline, which a
    section name can contain - a CSV cell certainly can. An ambiguous key
    files a case under a section nobody named.
  */
  it("keeps section paths distinct when a name contains the key separator", () => {
    const file = minimalFile([
      ["C301", "One", "api", "S1", "Test Case (Text)", "b", "1", "a\nb > b"],
      ["C302", "Two", "api", "S1", "Test Case (Text)", "b", "1", "a > b"],
    ]);
    importIt(file);
    const suiteId = (database.prepare("SELECT id FROM suites").get() as { id: number }).id;
    const names = sectionTree(database, suiteId).map((node) => `${node.depth}:${node.name}`);
    expect(names).toEqual(["0:a\nb", "1:b", "0:a", "1:b"]);

    const sections = database
      .prepare("SELECT source_id, section_id FROM cases ORDER BY source_id")
      .all() as { source_id: number; section_id: number }[];
    expect(sections[0].section_id).not.toBe(sections[1].section_id);
  });

  /*
    A failed import used to store a report holding only the error message,
    throwing away every count and note it had already collected - the one
    outcome the import_runs row exists to prevent.
  */
  it("keeps what it had collected when an import fails partway", () => {
    const bad = toCsv([
      ["ID", "Title", "Suite", "Suite ID", "Template"],
      ["C1", "fine", "s", "S1", "Test Case (Text)"],
      ["C2", "broken", "s", "S1", "Nope Template"],
    ]);
    expect(() =>
      runCsvImport(database, bad, { projectId, dateOrder: "mdy", timeZone: "UTC" }),
    ).toThrow(/Nope Template/);

    const run = listImportRuns(database, {}).rows[0];
    expect(run.state).toBe("failed");
    const stored = JSON.parse(run.report ?? "{}") as ImportReport;
    expect(stored.errors[0].message).toMatch(/Nope Template/);
    expect(stored.notes.length).toBeGreaterThan(0);
  });
});
