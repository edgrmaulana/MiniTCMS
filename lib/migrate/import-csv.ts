/*
  The CSV import pipeline: drafts from lib/migrate/csv.ts resolved against
  the database and written as upserts. Translation happens in map.ts and
  csv.ts; this file only decides what to look up and in what order.

  Idempotency comes from the schema for suites and cases - UNIQUE(source,
  source_id) with ON CONFLICT DO UPDATE - and from the resolved path for
  sections, which a CSV export gives no id for at all.
*/

import type Database from "better-sqlite3";
import {
  ConflictError,
  NotFoundError,
  caseSourcesInProject,
  createImportRun,
  createSection,
  findUserByEmail,
  findUserIdsByName,
  getProject,
  listSectionsFlat,
  nowSeconds,
  updateImportRun,
  upsertCaseField,
  upsertCaseFromSource,
  upsertSuiteFromSource,
} from "../db.ts";
import { type CsvCaseDraft, type CsvCustomField, readCsvCases } from "./csv.ts";
import { type DateOrder, SOURCE_CSV, isValidTimeZone } from "./map.ts";
import {
  type EntityCounts,
  type ImportReport,
  addError,
  addNote,
  addUnmapped,
  countsFor,
  emptyReport,
  reconcile,
  startTimer,
} from "./report.ts";

export type CsvImportOptions = {
  projectId: number;
  dateOrder: DateOrder;
  timeZone: string;
  /* Display name -> email, the operator's override for identities a CSV
     cannot carry. */
  userMap?: ReadonlyMap<string, string>;
  dryRun?: boolean;
  allowMixedSources?: boolean;
};

/*
  Batched so one statement holds a write transaction for a bounded time. 500
  is the same chunk the bulk case writes use; a transaction per row makes a
  200k-case import take hours, and one transaction for all of them locks the
  database for the length of the import.
*/
const IMPORT_BATCH = 500;

class DryRunRollback extends Error {}

/*
  The same import, recorded in `import_runs` so a UI can poll it and an
  operator can read yesterday's report back. A dry run is recorded too: what
  a dry run found is the thing people argue about afterwards.

  A reconciliation failure marks the row `failed` and throws, but only after
  the report has been stored - a failure with no report to read is the least
  useful possible outcome.
*/
export function runCsvImport(
  database: Database.Database,
  text: string,
  options: CsvImportOptions,
): { importRunId: number; report: ImportReport } {
  const importRunId = createImportRun(database, options.dryRun ? `${SOURCE_CSV}:dry-run` : SOURCE_CSV);
  /*
    Owned here, not inside importCsv, so a failure halfway through still has
    everything collected up to that point to store. A stored report holding
    only the error message is the outcome this function exists to avoid.
  */
  const report = emptyReport(SOURCE_CSV);
  try {
    importCsv(database, text, options, report);
  } catch (error) {
    addError(report, {
      entity: "cases",
      sourceId: null,
      message: error instanceof Error ? error.message : String(error),
    });
    updateImportRun(database, importRunId, { state: "failed", report: JSON.stringify(report) });
    throw error;
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

export function importCsv(
  database: Database.Database,
  text: string,
  options: CsvImportOptions,
  report: ImportReport = emptyReport(SOURCE_CSV),
): ImportReport {
  if (!isValidTimeZone(options.timeZone)) {
    throw new ConflictError(`"${options.timeZone}" is not an IANA time zone name`);
  }
  const project = getProject(database, options.projectId);
  if (!project) throw new NotFoundError(`No project with id ${options.projectId}`);

  assertSingleSource(database, options, report);

  const stopReading = startTimer(report, "read");
  const { cases, fields } = readCsvCases(
    text,
    { dateOrder: options.dateOrder, timeZone: options.timeZone },
    report,
  );
  stopReading();

  const write = () => {
    writeCaseFields(database, fields, report);
    const suiteIds = writeSuites(database, cases, options.projectId, report);
    const sectionIds = writeSections(database, cases, suiteIds, report);
    writeCases(database, cases, { suiteIds, sectionIds, options, report });
  };

  if (!options.dryRun) {
    write();
    addNote(report, `imported into project ${options.projectId} (${project.name})`);
    return report;
  }

  /*
    A dry run does every write and then rolls back, rather than simulating
    them: a foreign key or a CHECK that would reject a row is exactly what
    the operator is running the dry run to find out about.
  */
  try {
    database.transaction(() => {
      write();
      throw new DryRunRollback();
    })();
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  addNote(report, `dry run against project ${options.projectId} (${project.name}): nothing written`);
  return report;
}

/*
  Plan section 6.7: the two sources have separate UNIQUE(source, source_id)
  spaces, so a CSV import into a project the API has already filled lands
  every case a second time and nothing in the schema notices.
*/
function assertSingleSource(
  database: Database.Database,
  options: CsvImportOptions,
  report: ImportReport,
): void {
  const existing = caseSourcesInProject(database, options.projectId).filter(
    (row) => row.source !== null && row.source !== SOURCE_CSV,
  );
  if (existing.length === 0) return;

  const summary = existing.map((row) => `${row.total} from ${row.source}`).join(", ");
  if (!options.allowMixedSources) {
    throw new ConflictError(
      `Project ${options.projectId} already holds cases from another source (${summary}). ` +
        `Importing both lands every case twice. Reset the project first, or pass ` +
        `--allow-mixed-sources if that is what you mean.`,
    );
  }
  addNote(report, `mixed sources allowed by the operator: ${summary}`);
}

/*
  Every column that is not a TestRail built-in becomes a text field. Text is
  honest rather than lazy: a CSV cell carries no type, and reading `dropdown`
  out of the distinct values seen would be inventing a definition. A later
  API import corrects the type in place, keyed on system_name.
*/
function writeCaseFields(
  database: Database.Database,
  fields: readonly CsvCustomField[],
  report: ImportReport,
): void {
  const stop = startTimer(report, "case_fields");
  const counts = countsFor(report, "case_fields");
  counts.fetched = fields.length;

  for (const field of fields) {
    const outcome = upsertCaseField(database, {
      systemName: field.systemName,
      label: field.label,
      type: "text",
      source: SOURCE_CSV,
    });
    tally(counts, outcome.action);
  }
  stop();
}

function writeSuites(
  database: Database.Database,
  cases: readonly CsvCaseDraft[],
  projectId: number,
  report: ImportReport,
): Map<number, number> {
  const stop = startTimer(report, "suites");
  const counts = countsFor(report, "suites");
  const names = new Map<number, string>();
  for (const draft of cases) names.set(draft.suiteSourceId, draft.suiteName);
  counts.fetched = names.size;

  const resolved = new Map<number, number>();
  for (const [sourceId, name] of names) {
    const outcome = upsertSuiteFromSource(database, {
      projectId,
      name,
      source: SOURCE_CSV,
      sourceId,
    });
    tally(counts, outcome.action);
    resolved.set(sourceId, outcome.id);
  }
  stop();
  return resolved;
}

/*
  Sections carry no source id, so the key is the resolved path within the
  suite. The existing tree is read once per suite and folded into a
  path -> id map; missing paths are created shortest-first so a parent
  always exists before its child. A second run of the same file finds every
  path already in the map and creates nothing.
*/
function writeSections(
  database: Database.Database,
  cases: readonly CsvCaseDraft[],
  suiteIds: ReadonlyMap<number, number>,
  report: ImportReport,
): Map<string, number> {
  const stop = startTimer(report, "sections");
  const counts = countsFor(report, "sections");

  const wanted = new Set<string>();
  for (const draft of cases) {
    const suiteId = suiteIds.get(draft.suiteSourceId);
    if (suiteId === undefined) continue;
    // Every ancestor is a path in its own right, not just the leaf.
    for (let length = 1; length <= draft.sectionPath.length; length += 1) {
      wanted.add(pathKey(suiteId, draft.sectionPath.slice(0, length)));
    }
  }
  counts.fetched = wanted.size;

  const resolved = new Map<string, number>();
  for (const suiteId of new Set(suiteIds.values())) {
    for (const [path, id] of existingPaths(database, suiteId)) resolved.set(path, id);
  }

  // Shallowest first, so a parent is always written before its child.
  const missing = [...wanted]
    .filter((key) => !resolved.has(key))
    .sort((left, right) => parsePathKey(left).segments.length - parsePathKey(right).segments.length);

  const create = database.transaction((keys: string[]) => {
    for (const key of keys) {
      const { suiteId, segments } = parsePathKey(key);
      const parentKey = segments.length > 1 ? pathKey(suiteId, segments.slice(0, -1)) : null;
      const parentId = parentKey === null ? null : resolved.get(parentKey);
      if (parentKey !== null && parentId === undefined) {
        throw new ConflictError(`Section path "${segments.join(" > ")}" has no parent to attach to`);
      }
      const id = createSection(database, {
        suiteId,
        parentId: parentId ?? null,
        name: segments[segments.length - 1],
      });
      resolved.set(key, id);
      counts.inserted += 1;
    }
  });

  for (let start = 0; start < missing.length; start += IMPORT_BATCH) {
    create(missing.slice(start, start + IMPORT_BATCH));
  }
  counts.unchanged = counts.fetched - counts.inserted;
  stop();
  return resolved;
}

function existingPaths(
  database: Database.Database,
  suiteId: number,
): Map<string, number> {
  const rows = listSectionsFlat(database, suiteId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const paths = new Map<string, number>();

  for (const row of rows) {
    const segments: string[] = [];
    let current: { id: number; parent_id: number | null; name: string } | undefined = row;
    // Bounded by the row count, so a parent_id cycle cannot spin forever.
    for (let step = 0; current && step <= rows.length; step += 1) {
      segments.unshift(current.name);
      current = current.parent_id === null ? undefined : byId.get(current.parent_id);
    }
    /*
      First one wins, and listSectionsFlat orders by id, so two siblings
      sharing a name always resolve to the one that existed first. Letting
      the later row overwrite would make the choice depend on row order.
    */
    const key = pathKey(suiteId, segments);
    if (!paths.has(key)) paths.set(key, row.id);
  }
  return paths;
}

/*
  JSON rather than a joined string, because a section name can contain any
  character a CSV cell can - including whatever separator looked safe. An
  ambiguous key does not fail, it quietly files a case under a section that
  does not exist, which is the kind of thing nobody finds for a year.
*/
function pathKey(suiteId: number, segments: readonly string[]): string {
  return JSON.stringify([suiteId, ...segments]);
}

function parsePathKey(key: string): { suiteId: number; segments: string[] } {
  const [suiteId, ...segments] = JSON.parse(key) as [number, ...string[]];
  return { suiteId, segments };
}

function writeCases(
  database: Database.Database,
  cases: readonly CsvCaseDraft[],
  context: {
    suiteIds: ReadonlyMap<number, number>;
    sectionIds: ReadonlyMap<string, number>;
    options: CsvImportOptions;
    report: ImportReport;
  },
): void {
  const { suiteIds, sectionIds, options, report } = context;
  const stop = startTimer(report, "cases");
  const counts = countsFor(report, "cases");
  const resolveUser = userResolver(database, options.userMap, report);
  const importedOn = nowSeconds();

  const writeBatch = database.transaction((batch: readonly CsvCaseDraft[]) => {
    for (const draft of batch) {
      const suiteId = suiteIds.get(draft.suiteSourceId);
      if (suiteId === undefined) {
        throw new ConflictError(`Case C${draft.sourceId} names suite S${draft.suiteSourceId}, which was not imported`);
      }
      const sectionKey = draft.sectionPath.length > 0 ? pathKey(suiteId, draft.sectionPath) : null;
      const sectionId = sectionKey === null ? null : (sectionIds.get(sectionKey) ?? null);

      if (draft.createdOn === null) {
        addUnmapped(report, {
          entity: "cases",
          sourceId: draft.sourceId,
          field: "Created On",
          value: "empty; stored as the import time because the column is NOT NULL",
        });
      }
      const createdOn = draft.createdOn ?? importedOn;
      const outcome = upsertCaseFromSource(database, {
        sectionId,
        suiteId,
        title: draft.title,
        templateId: draft.templateId,
        typeId: draft.typeId,
        priorityId: draft.priorityId,
        refs: draft.refs,
        estimate: draft.estimate,
        milestoneId: null,
        custom: Object.keys(draft.custom).length > 0 ? JSON.stringify(draft.custom) : null,
        createdBy: resolveUser(draft.createdByName, draft.sourceId, "Created By"),
        createdOn,
        updatedBy: resolveUser(draft.updatedByName, draft.sourceId, "Updated By"),
        updatedOn: draft.updatedOn,
        source: SOURCE_CSV,
        sourceId: draft.sourceId,
      });
      tally(counts, outcome.action);
    }
  });

  for (let start = 0; start < cases.length; start += IMPORT_BATCH) {
    writeBatch(cases.slice(start, start + IMPORT_BATCH));
  }
  stop();
}

/*
  A CSV has display names where the API has emails. A name resolves only on
  a unique match, and anything else is NULL plus a report line - never
  reassigned to whoever is closest. Cached per name because a 200k-case
  export has a handful of distinct authors and the lookup is a table scan.
*/
function userResolver(
  database: Database.Database,
  overrides: ReadonlyMap<string, string> | undefined,
  report: ImportReport,
): (name: string | null, sourceId: number, field: string) => number | null {
  const cache = new Map<string, number | null>();

  const lookup = (key: string, name: string): number | null => {
    const email = overrides?.get(key);
    if (email) return findUserByEmail(database, email)?.id ?? null;
    const matches = findUserIdsByName(database, name);
    return matches.length === 1 ? matches[0] : null;
  };

  return (name, sourceId, field) => {
    if (!name) return null;
    const key = name.toLowerCase();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const resolved = lookup(key, name);
    cache.set(key, resolved);
    if (resolved === null) {
      /*
        Once per distinct name, not once per case: the name is what the
        operator has to go and fix, and 200k identical lines say no more
        than one does.
      */
      addUnmapped(report, {
        entity: "cases",
        sourceId,
        field,
        value: `"${name}" did not resolve to exactly one user; every case of theirs stored NULL`,
      });
    }
    return resolved;
  };
}

function tally(counts: EntityCounts, action: "inserted" | "updated" | "unchanged"): void {
  counts[action] += 1;
}
