/*
  Reader for a TestRail case CSV export. A different format from the API,
  not a thinner one, so it gets its own parser and its own mapper rather
  than a translation layer in front of the JSON path.

  Everything here is pure: text in, drafts out. Resolving those drafts
  against the database is lib/migrate/import-csv.ts.

  The format facts this is built against were measured on a real 243-case
  export, documented in plan/04-testrail-migration.md section 6.1: UTF-8,
  CRLF, RFC 4180 quoting, newlines inside fields on 241 of 243 rows, and
  header names that repeat.
*/

import {
  type DateOrder,
  MappingError,
  assertSectionPath,
  parseCsvTimestamp,
  parseSourceId,
  priorityFromLabel,
  slugifyFieldName,
  splitSectionPath,
  templateFromLabel,
  typeFromLabel,
} from "./map.ts";
import { type ImportReport, addNote, addSkipped, addUnmapped, countsFor } from "./report.ts";

const BYTE_ORDER_MARK = "﻿";

/*
  Whole-file parse. The upload route caps a file at 32MB and a browser is the
  realistic entry point, so streaming buys nothing yet.
  ponytail: whole string in memory; stream it if a CLI import ever outgrows
  the upload cap.
*/
export function parseCsv(input: string): string[][] {
  const text = input.startsWith(BYTE_ORDER_MARK) ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let position = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (position < text.length) {
    const char = text[position];

    if (inQuotes) {
      // A doubled quote inside a quoted field is one literal quote.
      if (char === '"' && text[position + 1] === '"') {
        field += '"';
        position += 2;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
        position += 1;
        continue;
      }
      field += char;
      position += 1;
      continue;
    }

    if (char === '"' && field === "") {
      inQuotes = true;
      position += 1;
      continue;
    }
    if (char === ",") {
      endField();
      position += 1;
      continue;
    }
    if (char === "\n" || char === "\r") {
      endRow();
      position += char === "\r" && text[position + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += char;
    position += 1;
  }

  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/*
  TestRail's own case columns. Everything else in the header is a custom
  field for this instance - the column set is whatever the exporting user
  ticked, so the header is data, not a schema.
*/
const BUILT_IN_COLUMNS = [
  "ID",
  "Title",
  "Section",
  "Section Depth",
  "Section Description",
  "Section Hierarchy",
  "Suite",
  "Suite ID",
  "Template",
  "Type",
  "Priority",
  "Estimate",
  "References",
  "Refs",
  "Milestone",
  "Attachments",
  "Created By",
  "Created On",
  "Updated By",
  "Updated On",
] as const;

/*
  TestRail ships these as custom fields too, but phase 2 already chose names
  for them, so they map to those rather than being slugified into a second
  set of near-duplicates.
*/
const STANDARD_FIELD_NAMES: Record<string, string> = {
  Preconditions: "preconds",
  Steps: "steps_text",
  "Expected Result": "expected",
  Mission: "mission",
  Goals: "goals",
};

/*
  A Steps-template export repeats one case across several rows, one per
  step. Reading half of that is worse than declining it, so a file with any
  of these columns filled refuses until the format has a second real sample
  to build against (plan section 6.5).
*/
const STEP_COLUMNS = [
  "Steps (Step)",
  "Steps (Expected Result)",
  "Steps (References)",
  "Steps (Additional Info)",
  "Steps (Shared step ID)",
];

/*
  Four columns the reader cannot do without, and none of them has a safe
  default: without "Suite" a suite would need an invented name, and without
  "Template" the step columns cannot be read correctly. Refusing with the
  list is better than importing a guess.
*/
const REQUIRED_COLUMNS = ["ID", "Title", "Suite", "Suite ID", "Template"];

export type CsvReadOptions = {
  dateOrder: DateOrder;
  timeZone: string;
};

export type CsvCustomField = {
  systemName: string;
  label: string;
  columnIndex: number;
};

export type CsvCaseDraft = {
  sourceId: number;
  suiteSourceId: number;
  suiteName: string;
  sectionPath: string[];
  sectionDescription: string | null;
  title: string;
  templateId: number;
  typeId: number | null;
  priorityId: number | null;
  refs: string | null;
  estimate: string | null;
  custom: Record<string, string>;
  createdByName: string | null;
  createdOn: number | null;
  updatedByName: string | null;
  updatedOn: number | null;
};

export type CsvReadResult = {
  cases: CsvCaseDraft[];
  fields: CsvCustomField[];
};

/*
  Parses the file, checks the invariants that detect a misread, and returns
  one draft per case. Hard errors throw and name the case; anything the
  format simply cannot carry lands in the report and the case still imports.
*/
export function readCsvCases(
  text: string,
  options: CsvReadOptions,
  report: ImportReport,
): CsvReadResult {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new MappingError("The file is empty");

  const header = rows[0].map((name) => name.trim());
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => cell.trim() !== ""));

  const columnIndex = firstIndexByName(header);
  const missing = REQUIRED_COLUMNS.filter((name) => columnIndex.get(name) === undefined);
  if (missing.length > 0) {
    throw new MappingError(
      `The export is missing required columns: ${missing.join(", ")}. ` +
        `Re-export with those columns ticked.`,
    );
  }

  const fields = customFields(header, columnIndex, report);
  refuseStepsExport(columnIndex, dataRows);

  addNote(report, `columns recognised: ${BUILT_IN_COLUMNS.filter((name) => columnIndex.has(name)).join(", ")}`);
  addNote(
    report,
    fields.length === 0
      ? "custom field columns: none"
      : `custom field columns: ${fields.map((field) => `${field.label} -> ${field.systemName}`).join(", ")}`,
  );

  const cases: CsvCaseDraft[] = [];
  const seenIds = new Map<number, number>();

  for (const [rowOffset, row] of dataRows.entries()) {
    const lineNumber = rowOffset + 2;
    const draft = readCaseRow(row, { columnIndex, fields, options, report, lineNumber });

    const previousLine = seenIds.get(draft.sourceId);
    if (previousLine !== undefined) {
      throw new MappingError(
        `Case C${draft.sourceId} appears on lines ${previousLine} and ${lineNumber}. ` +
          `Repeated ids mean a Steps-template export, which is not supported yet.`,
      );
    }
    seenIds.set(draft.sourceId, lineNumber);
    cases.push(draft);
  }

  countsFor(report, "cases").fetched = cases.length;
  return { cases, fields };
}

function firstIndexByName(header: readonly string[]): Map<string, number> {
  const indexes = new Map<string, number>();
  for (const [index, name] of header.entries()) {
    if (!indexes.has(name)) indexes.set(name, index);
  }
  return indexes;
}

/*
  Columns are addressed by index, never through a Record keyed on the header
  row: `Steps` appeared twice in the real export, and a header-keyed object
  loses one of them silently. A repeated name keeps both columns and the
  second gets a numbered system_name so neither value is dropped.
*/
function customFields(
  header: readonly string[],
  columnIndex: ReadonlyMap<string, number>,
  report: ImportReport,
): CsvCustomField[] {
  const builtIn = new Set<string>(BUILT_IN_COLUMNS);
  const stepColumns = new Set(STEP_COLUMNS);
  const fields: CsvCustomField[] = [];
  const takenNames = new Map<string, number>();

  for (const [index, label] of header.entries()) {
    if (!label) continue;
    if (stepColumns.has(label)) continue;
    if (builtIn.has(label) && columnIndex.get(label) === index) continue;

    const baseName = STANDARD_FIELD_NAMES[label] ?? slugifyFieldName(label);
    const previous = takenNames.get(baseName) ?? 0;
    const systemName = previous === 0 ? baseName : `${baseName}_${previous + 1}`;
    takenNames.set(baseName, previous + 1);

    if (previous > 0) {
      addNote(
        report,
        `column "${label}" (index ${index}) repeats an earlier name; imported as "${systemName}"`,
      );
    }
    fields.push({ systemName, label, columnIndex: index });
  }
  return fields;
}

function refuseStepsExport(
  columnIndex: ReadonlyMap<string, number>,
  dataRows: readonly string[][],
): void {
  const present = STEP_COLUMNS.filter((name) => columnIndex.has(name));
  if (present.length === 0) return;

  for (const [rowOffset, row] of dataRows.entries()) {
    for (const name of present) {
      const index = columnIndex.get(name);
      if (index !== undefined && (row[index] ?? "").trim() !== "") {
        throw new MappingError(
          `Line ${rowOffset + 2} has a value in "${name}". Steps-template exports ` +
            `spread one case over several rows and are not supported yet; ` +
            `re-export with the Text template, or import that suite through the API.`,
        );
      }
    }
  }
}

type RowContext = {
  columnIndex: ReadonlyMap<string, number>;
  fields: readonly CsvCustomField[];
  options: CsvReadOptions;
  report: ImportReport;
  lineNumber: number;
};

function readCaseRow(row: readonly string[], context: RowContext): CsvCaseDraft {
  const { columnIndex, options, report, lineNumber } = context;
  const cell = (name: string): string => {
    const index = columnIndex.get(name);
    return index === undefined ? "" : (row[index] ?? "").trim();
  };

  const rawId = cell("ID");
  if (!rawId) throw new MappingError(`Line ${lineNumber} has no ID`);
  const sourceId = parseSourceId(rawId, "Case");

  const title = cell("Title");
  if (!title) throw new MappingError(`Case C${sourceId} has no title`);

  const draft: CsvCaseDraft = {
    sourceId,
    suiteSourceId: parseSourceId(cell("Suite ID"), "Suite"),
    suiteName: cell("Suite"),
    sectionPath: sectionPathFor(cell, sourceId),
    sectionDescription: cell("Section Description") || null,
    title,
    templateId: templateFromLabel(cell("Template")),
    typeId: null,
    priorityId: null,
    refs: cell("References") || cell("Refs") || null,
    estimate: cell("Estimate") || null,
    custom: {},
    createdByName: cell("Created By") || null,
    createdOn: readDate(cell("Created On"), "Created On", sourceId, options),
    updatedByName: cell("Updated By") || null,
    updatedOn: readDate(cell("Updated On"), "Updated On", sourceId, options),
  };

  const typeLabel = cell("Type");
  draft.typeId = typeLabel ? typeFromLabel(typeLabel) : null;
  if (typeLabel && draft.typeId === null) {
    addUnmapped(report, { entity: "cases", sourceId, field: "Type", value: typeLabel });
  }

  const priorityLabel = cell("Priority");
  draft.priorityId = priorityLabel ? priorityFromLabel(priorityLabel) : null;
  if (priorityLabel && draft.priorityId === null) {
    addUnmapped(report, { entity: "cases", sourceId, field: "Priority", value: priorityLabel });
  }

  // No milestone rows exist in a case export, so the name resolves to nothing.
  const milestone = cell("Milestone");
  if (milestone) {
    addUnmapped(report, { entity: "cases", sourceId, field: "Milestone", value: milestone });
  }

  // The column holds filenames; the bytes live behind the API.
  const attachments = cell("Attachments");
  if (attachments) {
    addSkipped(report, {
      entity: "attachments",
      sourceId,
      reason: `"${attachments}" is only a filename in a CSV export; the file lives behind the API`,
    });
    countsFor(report, "attachments").fetched += 1;
  }

  for (const field of context.fields) {
    const value = (row[field.columnIndex] ?? "").trim();
    // An empty cell is an absent value, not an empty string.
    if (value) draft.custom[field.systemName] = value;
  }
  return draft;
}

/*
  Both invariants the real export held on all 243 rows are asserted per row:
  the depth column agrees with the segment count, and the leaf equals the
  `Section` column. They are the detector for a path split on a separator
  that appeared inside a section name - without them, a wrong split quietly
  reparents a whole subtree.
*/
function sectionPathFor(cell: (name: string) => string, sourceId: number): string[] {
  const hierarchy = cell("Section Hierarchy");
  const leaf = cell("Section");

  if (!hierarchy) return leaf ? [leaf] : [];

  const segments = splitSectionPath(hierarchy);
  const depth = cell("Section Depth");
  if (!leaf || !depth) {
    throw new MappingError(
      `Case C${sourceId} has a section hierarchy but no "Section" and "Section Depth" ` +
        `columns to check it against. Re-export with both ticked.`,
    );
  }
  assertSectionPath(segments, { depth: Number(depth), leaf }, `C${sourceId}`);
  return segments;
}

function readDate(
  value: string,
  column: string,
  sourceId: number,
  options: CsvReadOptions,
): number | null {
  try {
    return parseCsvTimestamp(value, options);
  } catch (error) {
    throw new MappingError(
      `Case C${sourceId}, ${column}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
