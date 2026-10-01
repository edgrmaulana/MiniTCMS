/*
  The API import pipeline. Foreign keys force the order and the order is the
  whole design: users, statuses and field definitions first, then projects,
  then each project's suites and milestones, then sections and cases, then
  plans, runs, tests and results.

  Every step is checkpointed by name in `import_runs.cursor`, so a resume
  skips what already landed instead of re-reading an instance from stage one.
  Nothing is ever deleted to make an import work.
*/

import type Database from "better-sqlite3";
import {
  ConflictError,
  type ImportRow,
  type ImportTable,
  type UpsertAction,
  caseSourcesInProject,
  createImportRun,
  existingCaseUpdatedOn,
  getImportRun,
  importWriter,
  listStatuses,
  sourceIdMap,
  updateImportRun,
  upsertCaseField,
  upsertStatus,
  upsertUserFromSource,
} from "../db.ts";
import type { TestRailClient } from "../testrail.ts";
import { CASE_TEMPLATE, RESULT_STATUS, SUITE_MODE, isCaseFieldType } from "../format.ts";
import {
  type Mapped,
  MappingError,
  SOURCE_API,
  type TestRailRow,
  type UnmappedField,
  labelledIdMap,
  mapCase,
  mapCaseField,
  mapMilestone,
  mapPlan,
  mapProject,
  mapResult,
  mapRun,
  mapSection,
  mapStatus,
  mapSuite,
  mapTest,
  mapUser,
  priorityFromLabel,
  typeFromLabel,
} from "./map.ts";
import {
  type EntityCounts,
  type ImportEntity,
  type ImportReport,
  addError,
  addNote,
  addUnmapped,
  countsFor,
  emptyReport,
  reconcile,
  startTimer,
} from "./report.ts";

export type ApiImportOptions = {
  /* TestRail project ids, for a trial import of one project. Empty means
     every project the account can see. */
  projectSourceIds?: readonly number[];
  dryRun?: boolean;
  /* An import_runs id to continue. Its cursor says which steps are done. */
  resumeFrom?: number;
  allowMixedSources?: boolean;
  onProgress?: (step: string) => void;
};

/* One statement's worth of rows per transaction, same bound as the bulk
   case writes: a transaction per row makes a 200k-case import take hours,
   one transaction for the lot holds a write lock for the whole import. */
const IMPORT_BATCH = 500;

/* TestRail pages lists at 250 and will not go higher. */
const PAGE_SIZE = 250;

type Cursor = { done: string[] };

export async function runApiImport(
  database: Database.Database,
  client: TestRailClient,
  options: ApiImportOptions = {},
): Promise<{ importRunId: number; report: ImportReport }> {
  const report = emptyReport(SOURCE_API);
  const { importRunId, done } = openImportRun(database, options);

  const checkpoint = (step: string): void => {
    done.add(step);
    // A dry run writes no cursor: it is going to be rolled back, and a
    // cursor claiming the work landed would make the next resume skip it.
    if (!options.dryRun) {
      updateImportRun(database, importRunId, { cursor: JSON.stringify({ done: [...done] }) });
    }
  };

  /*
    A dry run runs every real write and rolls the lot back, because a CHECK
    or a foreign key that would reject a row is exactly what the operator is
    running a dry run to find out about. BEGIN by hand rather than
    database.transaction(): the pipeline awaits between writes, and the
    wrapper refuses an async callback.

    It does hold a write transaction for the length of the dry run. That is
    the cost of finding out before the real import, and a dry run is a
    deliberate, supervised thing.
  */
  if (options.dryRun) database.exec("BEGIN");
  try {
    await importEverything(database, client, options, report, done, checkpoint);
  } catch (error) {
    addError(report, {
      entity: "cases",
      sourceId: null,
      message: error instanceof Error ? error.message : String(error),
    });
    if (options.dryRun) database.exec("ROLLBACK");
    updateImportRun(database, importRunId, { state: "failed", report: JSON.stringify(report) });
    throw error;
  }

  if (options.dryRun) {
    database.exec("ROLLBACK");
    addNote(report, "dry run: every row was mapped and written, then rolled back");
  }

  const complaints = reconcile(report);
  updateImportRun(database, importRunId, {
    state: complaints.length === 0 ? "done" : "failed",
    report: JSON.stringify(report),
  });
  if (complaints.length > 0) {
    throw new ConflictError(`The import did not reconcile: ${complaints.join("; ")}`);
  }
  return { importRunId, report };
}

function openImportRun(
  database: Database.Database,
  options: ApiImportOptions,
): { importRunId: number; done: Set<string> } {
  if (options.resumeFrom === undefined) {
    return {
      importRunId: createImportRun(database, options.dryRun ? `${SOURCE_API}:dry-run` : SOURCE_API),
      done: new Set(),
    };
  }
  const previous = getImportRun(database, options.resumeFrom);
  if (!previous) throw new ConflictError(`No import run with id ${options.resumeFrom}`);
  if (previous.state === "done") {
    throw new ConflictError(`Import run ${options.resumeFrom} already finished`);
  }
  const cursor = previous.cursor ? (JSON.parse(previous.cursor) as Cursor) : { done: [] };
  updateImportRun(database, options.resumeFrom, { state: "running" });
  return { importRunId: options.resumeFrom, done: new Set(cursor.done) };
}

type Pipeline = {
  database: Database.Database;
  client: TestRailClient;
  options: ApiImportOptions;
  report: ImportReport;
  done: ReadonlySet<string>;
  checkpoint: (step: string) => void;
  ids: Record<ImportTable, Map<number, number>>;
  statusIds: Set<number>;
  priorityIds: Map<number, number>;
  typeIds: Map<number, number>;
  templateIds: Map<number, number>;
};

async function importEverything(
  database: Database.Database,
  client: TestRailClient,
  options: ApiImportOptions,
  report: ImportReport,
  done: ReadonlySet<string>,
  checkpoint: (step: string) => void,
): Promise<void> {
  /*
    Every id map is rebuilt from the database, not carried over from the
    fetched pages, so a resumed import resolves a parent that a previous
    attempt wrote just as well as one it wrote itself.
  */
  const ids = {} as Record<ImportTable, Map<number, number>>;
  for (const table of [
    "users",
    "projects",
    "suites",
    "sections",
    "milestones",
    "cases",
    "plans",
    "runs",
    "tests",
    "results",
  ] as const) {
    ids[table] = sourceIdMap(database, table, SOURCE_API);
  }

  const pipeline: Pipeline = {
    database,
    client,
    options,
    report,
    done,
    checkpoint,
    ids,
    statusIds: new Set(listStatuses(database).map((status) => status.id)),
    priorityIds: new Map(),
    typeIds: new Map(),
    templateIds: new Map(),
  };

  await importUsers(pipeline);
  await importStatuses(pipeline);
  await importCaseFields(pipeline);
  await importLookups(pipeline);
  await importProjects(pipeline);

  addNote(
    report,
    "attachments were not fetched: the bytes live behind a second call per row " +
      "and that stage is not built yet (plan section 4, stage 15)",
  );
}

/*
  A step runs once per import run; a resume skips what the cursor names.
  `name` is the cursor key and is unique per row (`suite:20:cases`); `stage`
  is what the duration section totals under, so every suite's cases add up to
  one "cases" line rather than one line per suite.
*/
async function step(
  pipeline: Pipeline,
  name: string,
  stage: ImportEntity | "lookups",
  body: () => Promise<void>,
): Promise<void> {
  if (pipeline.done.has(name)) return;
  pipeline.options.onProgress?.(name);
  const stop = startTimer(pipeline.report, stage);
  await body();
  stop();
  pipeline.checkpoint(name);
}

async function importUsers(pipeline: Pipeline): Promise<void> {
  await step(pipeline, "users", "users", async () => {
    const rows = await pipeline.client.getAll<TestRailRow>("get_users", "users", {
      limit: PAGE_SIZE,
    });
    const counts = countsFor(pipeline.report, "users");
    counts.fetched += rows.length;

    writeBatched(pipeline.database, rows, (user) => {
      const mapped = mapUser(user);
      const outcome = upsertUserFromSource(pipeline.database, {
        ...mapped,
        /* TestRail's role ids are instance-specific and its permission model
           is not ours, so an imported account lands on the lowest role.
           Least privilege, and the operator promotes who needs it. */
        role: "tester",
        source: SOURCE_API,
        sourceId: mapped.sourceId,
      });
      pipeline.ids.users.set(mapped.sourceId, outcome.id);
      tally(counts, outcome.action);
    });
    addNote(
      pipeline.report,
      `every imported user got the "tester" role; TestRail's role ids do not map to ours`,
    );
  });
}

async function importStatuses(pipeline: Pipeline): Promise<void> {
  await step(pipeline, "statuses", "statuses", async () => {
    const rows = await pipeline.client.getAll<TestRailRow>("get_statuses", "statuses");
    const counts = countsFor(pipeline.report, "statuses");
    counts.fetched += rows.length;

    writeBatched(pipeline.database, rows, (status) => {
      const mapped = mapStatus(status);
      /* 1-5 are identical by construction - phase 1 pinned them to
         TestRail's own ids - so they are left exactly as seeded. */
      if (mapped.id <= RESULT_STATUS.failed) {
        counts.unchanged += 1;
        pipeline.statusIds.add(mapped.id);
        return;
      }
      tally(counts, upsertStatus(pipeline.database, mapped).action);
      pipeline.statusIds.add(mapped.id);
    });
  });
}

async function importCaseFields(pipeline: Pipeline): Promise<void> {
  await step(pipeline, "case_fields", "case_fields", async () => {
    const rows = await pipeline.client.getAll<TestRailRow>("get_case_fields", "case_fields");
    const counts = countsFor(pipeline.report, "case_fields");
    counts.fetched += rows.length;

    writeBatched(pipeline.database, rows, (field) => {
      const mapped = mapCaseField(field);
      for (const entry of mapped.unmapped) {
        addUnmapped(pipeline.report, {
          entity: "case_fields",
          sourceId: field.id,
          field: entry.field,
          value: entry.value,
        });
      }
      const outcome = upsertCaseField(pipeline.database, {
        systemName: mapped.systemName,
        label: mapped.label,
        type: mapped.type,
        configs: mapped.configs,
        source: SOURCE_API,
        sourceId: mapped.sourceId,
      });
      tally(counts, outcome.action);
      if (!isCaseFieldType(mapped.type)) {
        addNote(
          pipeline.report,
          `field "${mapped.systemName}" has type ${mapped.type}; values are preserved verbatim`,
        );
      }
    });
  });
}

/*
  Priorities, case types and templates are not rows we store - they are
  translation tables. They are re-read on every run, including a resume,
  because they are three cheap calls and a stale one silently mistranslates
  every case.
*/
async function importLookups(pipeline: Pipeline): Promise<void> {
  pipeline.options.onProgress?.("lookups");

  const priorities = await pipeline.client.getAll<TestRailRow>("get_priorities", "priorities");
  const priorityMap = labelledIdMap(priorities, priorityFromLabel);
  pipeline.priorityIds = priorityMap.ids;

  const types = await pipeline.client.getAll<TestRailRow>("get_case_types", "case_types");
  const typeMap = labelledIdMap(types, typeFromLabel);
  pipeline.typeIds = typeMap.ids;

  const templates = await pipeline.client.getAll<TestRailRow>("get_templates", "templates");
  /* Templates decide how a case's step fields are read, so an unknown name
     is reported rather than thrown here: the case mapper falls back to the
     text template and says so per case. */
  const templateMap = labelledIdMap(templates, templateLabelToId);
  pipeline.templateIds = templateMap.ids;

  for (const [entity, unmatched] of [
    ["priorities", priorityMap.unmatched],
    ["case types", typeMap.unmatched],
    ["templates", templateMap.unmatched],
  ] as const) {
    for (const row of unmatched) {
      addUnmapped(pipeline.report, {
        entity: "cases",
        sourceId: null,
        field: entity,
        value: `"${row.label}" (TestRail id ${row.id}) matches nothing in lib/format.ts`,
      });
    }
  }
}

function templateLabelToId(label: string): number | null {
  const wanted = label.trim().toLowerCase();
  if (wanted.includes("steps")) return CASE_TEMPLATE.steps;
  if (wanted.includes("exploratory")) return CASE_TEMPLATE.exploratory;
  if (wanted.includes("text")) return CASE_TEMPLATE.text;
  return null;
}

async function importProjects(pipeline: Pipeline): Promise<void> {
  const projects = await pipeline.client.getAll<TestRailRow>("get_projects", "projects", {
    limit: PAGE_SIZE,
  });
  const wanted =
    pipeline.options.projectSourceIds && pipeline.options.projectSourceIds.length > 0
      ? projects.filter((project) => pipeline.options.projectSourceIds?.includes(project.id))
      : projects;

  if (pipeline.options.projectSourceIds?.length && wanted.length === 0) {
    throw new ConflictError(
      `None of the requested projects exist on this instance: ` +
        `${pipeline.options.projectSourceIds.join(", ")}`,
    );
  }

  /*
    Counted inside the step, not out here: a resume skips the step, and a
    row counted as fetched with nothing written against it fails
    reconciliation on every resume.
  */
  const counts = countsFor(pipeline.report, "projects");

  for (const project of wanted) {
    await step(pipeline, `project:${project.id}`, "projects", async () => {
      counts.fetched += 1;
      const mapped = mapProject(project, SOURCE_API);
      recordUnmapped(pipeline.report, "projects", project.id, mapped.unmapped);
      const outcome = write(pipeline.database, "projects", mapped.row);
      pipeline.ids.projects.set(project.id, outcome.id);
      tally(counts, outcome.action);
    });

    const projectId = pipeline.ids.projects.get(project.id);
    if (projectId === undefined) {
      throw new ConflictError(`Project ${project.id} was checkpointed but is not in the database`);
    }
    await importProjectBody(pipeline, project.id, projectId, Number(project.suite_mode ?? SUITE_MODE.single));
  }
}

async function importProjectBody(
  pipeline: Pipeline,
  projectSourceId: number,
  projectId: number,
  suiteMode: number,
): Promise<void> {
  assertSingleSource(pipeline, projectId);

  const suites = await pipeline.client.getAll<TestRailRow>(
    `get_suites/${projectSourceId}`,
    "suites",
  );
  await step(pipeline, `project:${projectSourceId}:suites`, "suites", async () => {
    const counts = countsFor(pipeline.report, "suites");
    counts.fetched += suites.length;
    writeBatched(pipeline.database, suites, (suite) => {
      const mapped = mapSuite(suite, projectId, SOURCE_API);
      recordUnmapped(pipeline.report, "suites", suite.id, mapped.unmapped);
      const outcome = write(pipeline.database, "suites", mapped.row);
      pipeline.ids.suites.set(suite.id, outcome.id);
      tally(counts, outcome.action);
    });
  });

  await step(pipeline, `project:${projectSourceId}:milestones`, "milestones", async () => {
    const milestones = await pipeline.client.getAll<TestRailRow>(
      `get_milestones/${projectSourceId}`,
      "milestones",
    );
    const counts = countsFor(pipeline.report, "milestones");
    counts.fetched += milestones.length;
    writeNested(pipeline, milestones, "milestones", counts, (milestone) =>
      mapMilestone(milestone, {
        projectId,
        milestoneIds: pipeline.ids.milestones,
        source: SOURCE_API,
      }),
    );
  });

  for (const suite of suites) {
    const suiteId = pipeline.ids.suites.get(suite.id);
    if (suiteId === undefined) continue;
    await importSuiteBody(pipeline, projectSourceId, suite.id, suiteId, suiteMode);
  }

  const planSourceIds = await importPlans(pipeline, projectSourceId, projectId);
  await importRuns(pipeline, projectSourceId, projectId, planSourceIds);
}

/*
  Plan section 6.7 from the other direction: a project already filled by a
  CSV import has its cases under source 'testrail-csv', and the UNIQUE index
  is per source - so importing the API on top lands every case a second time
  and nothing in the schema notices.
*/
function assertSingleSource(pipeline: Pipeline, projectId: number): void {
  const other = caseSourcesInProject(pipeline.database, projectId).filter(
    (row) => row.source !== null && row.source !== SOURCE_API,
  );
  if (other.length === 0) return;

  const summary = other.map((row) => `${row.total} from ${row.source}`).join(", ");
  if (!pipeline.options.allowMixedSources) {
    throw new ConflictError(
      `Project ${projectId} already holds cases from another source (${summary}). ` +
        `Importing both lands every case twice. Reset the project first, or pass ` +
        `--allow-mixed-sources if that is what you mean.`,
    );
  }
  addNote(pipeline.report, `mixed sources allowed by the operator: ${summary}`);
}

/*
  `suite_id` is documented as optional for a project in single-suite mode,
  and TestRail rejects the call outright on some versions when it is sent
  anyway - "Field :suite_id is not a valid or accessible test suite". Single
  suite is TestRail's default, so getting this wrong would break the import
  for most instances. Omitting it is correct under either reading: a
  single-suite project has exactly one suite to return.
*/
async function importSuiteBody(
  pipeline: Pipeline,
  projectSourceId: number,
  suiteSourceId: number,
  suiteId: number,
  suiteMode: number,
): Promise<void> {
  const scope: Record<string, string | number> = { limit: PAGE_SIZE };
  if (suiteMode !== SUITE_MODE.single) scope.suite_id = suiteSourceId;

  await step(pipeline, `suite:${suiteSourceId}:sections`, "sections", async () => {
    const sections = await pipeline.client.getAll<TestRailRow>(
      `get_sections/${projectSourceId}`,
      "sections",
      scope,
    );
    const counts = countsFor(pipeline.report, "sections");
    counts.fetched += sections.length;
    writeNested(pipeline, sections, "sections", counts, (section) =>
      mapSection(section, { suiteId, sectionIds: pipeline.ids.sections, source: SOURCE_API }),
    );
  });

  await step(pipeline, `suite:${suiteSourceId}:cases`, "cases", async () => {
    const cases = await pipeline.client.getAll<TestRailRow>(
      `get_cases/${projectSourceId}`,
      "cases",
      scope,
    );
    const counts = countsFor(pipeline.report, "cases");
    counts.fetched += cases.length;
    writeBatched(pipeline.database, cases, (testrailCase) => {
      const mapped = mapCase(testrailCase, {
        suiteId,
        source: SOURCE_API,
        sectionIds: pipeline.ids.sections,
        milestoneIds: pipeline.ids.milestones,
        userIds: pipeline.ids.users,
        priorityIds: pipeline.priorityIds,
        typeIds: pipeline.typeIds,
        templateIds: pipeline.templateIds,
      });
      recordUnmapped(pipeline.report, "cases", testrailCase.id, mapped.unmapped);
      if (mapped.row.updated_on === null) {
        mapped.row.updated_on =
          existingCaseUpdatedOn(pipeline.database, SOURCE_API, testrailCase.id) ??
          mapped.row.created_on;
      }
      const outcome = write(pipeline.database, "cases", mapped.row);
      pipeline.ids.cases.set(testrailCase.id, outcome.id);
      tally(counts, outcome.action);
    });
  });
}

async function importPlans(
  pipeline: Pipeline,
  projectSourceId: number,
  projectId: number,
): Promise<number[]> {
  const plans = await pipeline.client.getAll<TestRailRow>(`get_plans/${projectSourceId}`, "plans", {
    limit: PAGE_SIZE,
  });
  await step(pipeline, `project:${projectSourceId}:plans`, "plans", async () => {
    const counts = countsFor(pipeline.report, "plans");
    counts.fetched += plans.length;
    writeBatched(pipeline.database, plans, (plan) => {
      const mapped = mapPlan(plan, {
        projectId,
        milestoneIds: pipeline.ids.milestones,
        source: SOURCE_API,
      });
      recordUnmapped(pipeline.report, "plans", plan.id, mapped.unmapped);
      const outcome = write(pipeline.database, "plans", mapped.row);
      pipeline.ids.plans.set(plan.id, outcome.id);
      tally(counts, outcome.action);
    });
  });
  return plans.map((plan) => plan.id);
}

/*
  `get_runs` answers with the runs that are not in a plan; the rest live
  inside each plan's entries. Both are runs here - `plan_entries` is not a
  table in v1, a run with plan_id set is an entry (plan section 7).
*/
async function importRuns(
  pipeline: Pipeline,
  projectSourceId: number,
  projectId: number,
  planSourceIds: readonly number[],
): Promise<void> {
  const standalone = await pipeline.client.getAll<TestRailRow>(
    `get_runs/${projectSourceId}`,
    "runs",
    { limit: PAGE_SIZE },
  );
  const fromPlans: TestRailRow[] = [];
  for (const planSourceId of planSourceIds) {
    const plan = await pipeline.client.get<{ entries?: { runs?: TestRailRow[] }[] }>(
      `get_plan/${planSourceId}`,
    );
    for (const entry of plan.entries ?? []) fromPlans.push(...(entry.runs ?? []));
  }

  // Newest first, so a half-finished import of a big instance is still the
  // useful half: this quarter's results rather than 2019's.
  const runs = [...standalone, ...fromPlans].sort(
    (left, right) => Number(right.created_on ?? 0) - Number(left.created_on ?? 0),
  );

  await step(pipeline, `project:${projectSourceId}:runs`, "runs", async () => {
    const counts = countsFor(pipeline.report, "runs");
    counts.fetched += runs.length;
    writeBatched(pipeline.database, runs, (run) => {
      const mapped = mapRun(run, {
        projectId,
        suiteIds: pipeline.ids.suites,
        planIds: pipeline.ids.plans,
        milestoneIds: pipeline.ids.milestones,
        source: SOURCE_API,
      });
      recordUnmapped(pipeline.report, "runs", run.id, mapped.unmapped);
      const outcome = write(pipeline.database, "runs", mapped.row);
      pipeline.ids.runs.set(run.id, outcome.id);
      tally(counts, outcome.action);
    });
  });

  for (const run of runs) {
    const runId = pipeline.ids.runs.get(run.id);
    if (runId === undefined) continue;
    await importRunBody(pipeline, run.id, runId);
  }
}

async function importRunBody(
  pipeline: Pipeline,
  runSourceId: number,
  runId: number,
): Promise<void> {
  await step(pipeline, `run:${runSourceId}:tests`, "tests", async () => {
    const tests = await pipeline.client.getAll<TestRailRow>(`get_tests/${runSourceId}`, "tests", {
      limit: PAGE_SIZE,
    });
    const counts = countsFor(pipeline.report, "tests");
    counts.fetched += tests.length;
    writeBatched(pipeline.database, tests, (test) => {
      const mapped = mapTest(test, {
        runId,
        caseIds: pipeline.ids.cases,
        userIds: pipeline.ids.users,
        knownStatusIds: pipeline.statusIds,
        source: SOURCE_API,
      });
      recordUnmapped(pipeline.report, "tests", test.id, mapped.unmapped);
      const outcome = write(pipeline.database, "tests", mapped.row);
      pipeline.ids.tests.set(test.id, outcome.id);
      tally(counts, outcome.action);
    });
  });

  await step(pipeline, `run:${runSourceId}:results`, "results", async () => {
    const results = await pipeline.client.getAll<TestRailRow>(
      `get_results_for_run/${runSourceId}`,
      "results",
      { limit: PAGE_SIZE },
    );
    const counts = countsFor(pipeline.report, "results");
    counts.fetched += results.length;
    writeBatched(pipeline.database, results, (result) => {
      const mapped = mapResult(result, {
        testIds: pipeline.ids.tests,
        userIds: pipeline.ids.users,
        knownStatusIds: pipeline.statusIds,
        source: SOURCE_API,
      });
      recordUnmapped(pipeline.report, "results", result.id, mapped.unmapped);
      const outcome = write(pipeline.database, "results", mapped.row);
      pipeline.ids.results.set(result.id, outcome.id);
      tally(counts, outcome.action);
    });
  });
}

/*
  Sections and milestones both nest, and TestRail does not promise parents
  come first. Rows whose parent is resolved are written, and the pass repeats
  until one makes no progress - at which point what is left is an orphan or a
  cycle, and that is an error with the ids in it, not a silently flattened
  tree.
*/
function writeNested(
  pipeline: Pipeline,
  rows: readonly TestRailRow[],
  table: Extract<ImportTable, "sections" | "milestones">,
  counts: EntityCounts,
  map: (row: TestRailRow) => Mapped,
): void {
  let pending = [...rows];
  const ids = pipeline.ids[table];

  while (pending.length > 0) {
    const ready: TestRailRow[] = [];
    const deferred: TestRailRow[] = [];
    for (const row of pending) {
      const parent = Number(row.parent_id ?? 0);
      if (parent === 0 || ids.has(parent)) ready.push(row);
      else deferred.push(row);
    }
    if (ready.length === 0) {
      throw new MappingError(
        `${table}: ${deferred.length} rows have a parent that is not in this export ` +
          `(ids ${deferred.slice(0, 10).map((row) => row.id).join(", ")})`,
      );
    }
    writeBatched(pipeline.database, ready, (row) => {
      const mapped = map(row);
      recordUnmapped(pipeline.report, table as ImportEntity, row.id, mapped.unmapped);
      const outcome = write(pipeline.database, table, mapped.row);
      ids.set(row.id, outcome.id);
      tally(counts, outcome.action);
    });
    pending = deferred;
  }
}

function write(
  database: Database.Database,
  table: ImportTable,
  row: ImportRow,
): { id: number; action: UpsertAction } {
  return importWriter(database, table)(row);
}

function writeBatched<Row>(
  database: Database.Database,
  rows: readonly Row[],
  writeOne: (row: Row) => void,
): void {
  const batch = database.transaction((slice: readonly Row[]) => {
    for (const row of slice) writeOne(row);
  });
  for (let start = 0; start < rows.length; start += IMPORT_BATCH) {
    batch(rows.slice(start, start + IMPORT_BATCH));
  }
}

function recordUnmapped(
  report: ImportReport,
  entity: ImportEntity,
  sourceId: number,
  entries: readonly UnmappedField[],
): void {
  for (const entry of entries) {
    addUnmapped(report, { entity, sourceId, field: entry.field, value: entry.value });
  }
}

function tally(counts: EntityCounts, action: UpsertAction): void {
  counts[action] += 1;
}
