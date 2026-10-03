/*
  TestRail -> MiniTCMS translation, and the only place it happens. Every
  function here is pure: inputs in, row fields out, no database and no
  network, so each one is testable against a fixture.

  Two callers with opposite inputs share this module on purpose. The API
  sends ids (`priority_id: 2`); a CSV export sends labels (`"Medium"`). They
  are different functions - `mapCase` and `mapCsvCase` are siblings, not one
  calling the other - but the id tables they resolve against are the same
  tables, declared once.
*/

import {
  CASE_PRIORITY,
  CASE_TEMPLATE,
  CASE_TYPE,
  DATE_ORDERS,
  MAX_SECTION_LEVELS,
  RESULT_STATUS,
  SUITE_MODE,
  type CaseFieldType,
  type DateOrder,
} from "../format.ts";
import type { ImportRow } from "../db.ts";

export class MappingError extends Error {}

export const SOURCE_API = "testrail";
export const SOURCE_CSV = "testrail-csv";

/*
  TestRail prefixes its display ids with one letter per entity: C1234567 is
  case 1234567, S928 is suite 928, R12 a run, M4 a milestone. Exactly one
  letter, then digits - a bare number is also accepted because some exports
  and some hand-edited files have had the prefix stripped already.
*/
export function parseSourceId(value: string, entity: string): number {
  const trimmed = value.trim();
  const match = /^[A-Za-z]?(\d+)$/.exec(trimmed);
  if (!match) {
    throw new MappingError(`${entity} id "${value}" is not a TestRail id like C123`);
  }
  const id = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new MappingError(`${entity} id "${value}" is out of range`);
  }
  return id;
}

/*
  Label matching is case-insensitive and whitespace-tolerant, and that is the
  whole of it. A TestRail instance can rename and reorder its priorities, so
  a label that does not match is a NULL plus a report line - never a quiet
  fallback to `other`, which would invent data the export never contained
  (AGENTS.md rule 4).
*/
function labelToId(table: Record<string, number>, label: string): number | null {
  const wanted = label.trim().toLowerCase();
  if (!wanted) return null;
  return Object.hasOwn(table, wanted) ? table[wanted] : null;
}

export function priorityFromLabel(label: string): number | null {
  return labelToId(CASE_PRIORITY, label);
}

export function typeFromLabel(label: string): number | null {
  return labelToId(CASE_TYPE, label);
}

/*
  TestRail's own template names. Unknown is a hard error rather than a NULL,
  because the template decides how the step columns are read: guessing it
  wrong silently loses every step in the file.
*/
const TEMPLATE_LABELS: Record<string, number> = {
  "test case (text)": CASE_TEMPLATE.text,
  "test case (steps)": CASE_TEMPLATE.steps,
  "exploratory session": CASE_TEMPLATE.exploratory,
};

export function templateFromLabel(label: string): number {
  const found = TEMPLATE_LABELS[label.trim().toLowerCase()];
  if (found === undefined) {
    throw new MappingError(
      `Unknown template "${label}". Known: ${Object.keys(TEMPLATE_LABELS).join(", ")}`,
    );
  }
  return found;
}

export const SECTION_PATH_SEPARATOR = " > ";

/*
  `Section Hierarchy` is the only section information a CSV export carries,
  and the separator is ambiguous the moment a section name contains " > ".
  The caller checks the two invariants the export guarantees - the depth
  column and the leaf name - which is what detects a wrong split before it
  reparents a whole subtree.
*/
export function splitSectionPath(value: string): string[] {
  return value
    .split(SECTION_PATH_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export function assertSectionPath(
  segments: string[],
  expected: { depth: number; leaf: string },
  caseId: number | string,
): void {
  if (segments.length === 0) {
    throw new MappingError(`Case ${caseId} has an empty section hierarchy`);
  }
  if (segments.length - 1 !== expected.depth) {
    throw new MappingError(
      `Case ${caseId}: section depth ${expected.depth} disagrees with ` +
        `${segments.length} path segments ("${segments.join(SECTION_PATH_SEPARATOR)}")`,
    );
  }
  if (segments[segments.length - 1] !== expected.leaf.trim()) {
    throw new MappingError(
      `Case ${caseId}: section "${expected.leaf}" is not the last segment of ` +
        `"${segments.join(SECTION_PATH_SEPARATOR)}"`,
    );
  }
  if (segments.length > MAX_SECTION_LEVELS) {
    throw new MappingError(
      `Case ${caseId}: section path is ${segments.length} levels deep, ` +
        `the schema allows ${MAX_SECTION_LEVELS}`,
    );
  }
}

/*
  A column header becomes a custom field's system_name: "Business_Unit" ->
  "business_unit". Collapsing anything non-alphanumeric means two different
  headers can collide, so the caller checks for a collision and reports it
  rather than letting the second field overwrite the first.
*/
export function slugifyFieldName(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) throw new MappingError(`Column "${label}" has no usable name`);
  return /^[0-9]/.test(slug) ? `f_${slug}` : slug;
}

// Declared in lib/format.ts, because the import screen offers the same two
// choices; re-exported here so the CSV reader stays the one import for callers.
export { DATE_ORDERS };
export type { DateOrder };

export function isDateOrder(value: string): value is DateOrder {
  return (DATE_ORDERS as readonly string[]).includes(value);
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const CSV_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;

/*
  "10/1/2026 6:26 PM" - locale-ordered, 12-hour, no offset. Which number is
  the month is a property of the exporting user's account settings and is not
  recoverable from the file, so both the order and the zone are operator
  inputs; this function never picks one. Returns null for an empty cell and
  throws for a cell that is non-empty and unreadable, because those are
  different facts: no date, versus a date we failed to read.
*/
export function parseCsvTimestamp(
  value: string,
  options: { dateOrder: DateOrder; timeZone: string },
): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = CSV_DATE.exec(trimmed);
  if (!match) throw new MappingError(`Cannot read date "${value}"`);

  const [, first, second, year, hour, minute, seconds, meridiem] = match;
  const month = Number(options.dateOrder === "mdy" ? first : second);
  const day = Number(options.dateOrder === "mdy" ? second : first);

  let hours = hour ? Number(hour) : 0;
  if (meridiem) {
    const isAfternoon = meridiem.toLowerCase() === "pm";
    if (hours < 1 || hours > 12) throw new MappingError(`Cannot read date "${value}"`);
    hours = (hours % 12) + (isAfternoon ? 12 : 0);
  }
  if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23) {
    throw new MappingError(`Cannot read date "${value}"`);
  }

  const wallClock = Date.UTC(
    Number(year),
    month - 1,
    day,
    hours,
    minute ? Number(minute) : 0,
    seconds ? Number(seconds) : 0,
  );
  return Math.floor(zonedWallClockToUnix(wallClock, options.timeZone) / 1000);
}

/*
  There is no stdlib "parse this wall clock in that zone". The offset depends
  on the instant, and the instant is what we are solving for, so: guess that
  the wall clock is UTC, measure the zone's offset at that guess, subtract,
  then measure once more. The second pass is what gets the hour around a DST
  change right; a single pass is off by an hour for a few hours a year, twice
  a year, which is exactly the kind of bug nobody finds until an audit.
*/
function zonedWallClockToUnix(wallClockUtc: number, timeZone: string): number {
  const firstOffset = zoneOffsetAt(wallClockUtc, timeZone);
  const firstGuess = wallClockUtc - firstOffset;
  const secondOffset = zoneOffsetAt(firstGuess, timeZone);
  return secondOffset === firstOffset ? firstGuess : wallClockUtc - secondOffset;
}

function zoneOffsetAt(instant: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(instant))) parts[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instant;
}

/*
  A CSV carries display names, not emails, so identity is a best-effort match
  the operator can override. An ambiguous or unknown name resolves to null and
  is reported; it is never assigned to whoever happens to be closest.
*/
export function parseUserMap(value: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) {
      throw new MappingError(`User map entry "${entry}" is not in name=email form`);
    }
    pairs.set(
      trimmed.slice(0, separator).trim().toLowerCase(),
      trimmed.slice(separator + 1).trim().toLowerCase(),
    );
  }
  return pairs;
}

/* ------------------------------------------------------------------ *
 * The API path
 *
 * One pure function per entity, each taking the TestRail JSON and a
 * context of already-resolved ids, each returning the row to write plus
 * whatever it could not translate. Nothing here queries or fetches, so
 * every one of them is a fixture test.
 * ------------------------------------------------------------------ */

export type UnmappedField = { field: string; value: string };

export type Mapped = { row: ImportRow; unmapped: UnmappedField[] };

/* TestRail rows arrive as plain JSON; nothing is assumed beyond `id`. */
export type TestRailRow = Record<string, unknown> & { id: number };

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const asString = String(value);
  return asString === "" ? null : asString;
}

function integer(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function flag(value: unknown): number {
  return value ? 1 : 0;
}

/*
  A reference to another TestRail row, resolved through the id map the
  import built for that table. An id we have never seen is reported rather
  than written as a dangling number - the foreign key would reject it
  anyway, and the report names the row.
*/
function reference(
  ids: ReadonlyMap<number, number>,
  sourceId: unknown,
  field: string,
  unmapped: UnmappedField[],
): number | null {
  const wanted = integer(sourceId);
  if (wanted === null || wanted === 0) return null;
  const resolved = ids.get(wanted);
  if (resolved === undefined) {
    unmapped.push({ field, value: `TestRail id ${wanted} was not imported` });
    return null;
  }
  return resolved;
}

export function mapUser(user: TestRailRow): {
  email: string;
  name: string | null;
  isActive: boolean;
  sourceId: number;
} {
  const email = text(user.email);
  if (!email) throw new MappingError(`TestRail user ${user.id} has no email`);
  return {
    email,
    name: text(user.name),
    isActive: Boolean(user.is_active ?? true),
    sourceId: user.id,
  };
}

/*
  TestRail stores a status colour as a packed integer per theme. The dark
  one is the one its own UI uses for the status pill, which is what our
  `statuses.color` feeds, so that is the one that carries over.
*/
export function trColorToHex(value: unknown): string | null {
  const packed = integer(value);
  if (packed === null || packed < 0 || packed > 0xffffff) return null;
  return `#${packed.toString(16).padStart(6, "0")}`;
}

export function mapStatus(status: TestRailRow): {
  id: number;
  systemName: string;
  label: string;
  color: string | null;
  isUntested: boolean;
  isFinal: boolean;
} {
  const systemName = text(status.name);
  if (!systemName) throw new MappingError(`TestRail status ${status.id} has no name`);
  return {
    id: status.id,
    systemName,
    label: text(status.label) ?? systemName,
    color: trColorToHex(status.color_dark),
    isUntested: Boolean(status.is_untested),
    isFinal: Boolean(status.is_final),
  };
}

/*
  TestRail's documented custom field type ids. An id outside this table
  still imports - the definition keeps the raw type name and the values are
  preserved verbatim - because losing a field is worse than storing one we
  cannot render yet.
*/
const FIELD_TYPE_BY_ID: Record<number, CaseFieldType> = {
  1: "string",
  2: "integer",
  3: "text",
  5: "checkbox",
  6: "dropdown",
  7: "user",
  8: "date",
  10: "steps",
  11: "multiselect",
};

export function mapCaseField(field: TestRailRow): {
  systemName: string;
  label: string;
  type: string;
  configs: string | null;
  sourceId: number;
  unmapped: UnmappedField[];
} {
  const rawName = text(field.system_name) ?? text(field.name);
  if (!rawName) throw new MappingError(`TestRail case field ${field.id} has no system name`);

  const unmapped: UnmappedField[] = [];
  const typeId = integer(field.type_id);
  const type = typeId === null ? undefined : FIELD_TYPE_BY_ID[typeId];
  if (!type) {
    unmapped.push({ field: "type_id", value: `${typeId ?? "null"} is not a known field type` });
  }
  return {
    systemName: stripCustomPrefix(rawName),
    label: text(field.label) ?? rawName,
    type: type ?? `testrail_${typeId ?? "unknown"}`,
    configs: field.configs === undefined ? null : JSON.stringify(field.configs),
    sourceId: field.id,
    unmapped,
  };
}

export function mapProject(project: TestRailRow, source: string): Mapped {
  const name = text(project.name);
  if (!name) throw new MappingError(`TestRail project ${project.id} has no name`);
  const unmapped: UnmappedField[] = [];

  const suiteMode = integer(project.suite_mode) ?? SUITE_MODE.single;
  if (!Object.values(SUITE_MODE).includes(suiteMode as never)) {
    unmapped.push({ field: "suite_mode", value: `${suiteMode} is not a documented suite mode` });
  }
  return {
    row: {
      name,
      announcement: text(project.announcement),
      suite_mode: Object.values(SUITE_MODE).includes(suiteMode as never)
        ? suiteMode
        : SUITE_MODE.single,
      is_completed: flag(project.is_completed),
      /*
        get_projects carries no created_on, so this is the import time -
        and it is an insert-only column, so a second import does not keep
        moving it. Borrowing completed_on would have been a guess dressed
        up as data.
      */
      created_on: nowSecondsForImport(),
      source,
      source_id: project.id,
    },
    unmapped,
  };
}

/*
  Kept here rather than imported from lib/db.ts so this module stays free of
  the database at runtime.
*/
function nowSecondsForImport(): number {
  return Math.floor(Date.now() / 1000);
}

/*
  TestRail suite_mode 2 is "single suite plus baselines". The baseline flag
  carries over; which suite a baseline was taken from is in neither
  get_suites nor get_suite/:id - both answer with the same nine fields - so
  `baseline_of` stays NULL and the row is reported. Confirmed against an
  instance with four mode-2 projects; see plan section 3.
*/
export function mapSuite(suite: TestRailRow, projectId: number, source: string): Mapped {
  const name = text(suite.name);
  if (!name) throw new MappingError(`TestRail suite ${suite.id} has no name`);
  const unmapped: UnmappedField[] = [];
  if (suite.is_baseline) {
    unmapped.push({ field: "baseline_of", value: "get_suites does not say which suite this baselines" });
  }
  return {
    row: {
      project_id: projectId,
      name,
      description: text(suite.description),
      is_baseline: flag(suite.is_baseline),
      baseline_of: null,
      source,
      source_id: suite.id,
    },
    unmapped,
  };
}

export function mapMilestone(
  milestone: TestRailRow,
  context: { projectId: number; milestoneIds: ReadonlyMap<number, number>; source: string },
): Mapped {
  const name = text(milestone.name);
  if (!name) throw new MappingError(`TestRail milestone ${milestone.id} has no name`);
  const unmapped: UnmappedField[] = [];
  return {
    row: {
      project_id: context.projectId,
      parent_id: reference(context.milestoneIds, milestone.parent_id, "parent_id", unmapped),
      name,
      description: text(milestone.description),
      due_on: integer(milestone.due_on),
      // TestRail calls it start_on; ours is started_on.
      started_on: integer(milestone.start_on),
      is_completed: flag(milestone.is_completed),
      source: context.source,
      source_id: milestone.id,
    },
    unmapped,
  };
}

export function mapSection(
  section: TestRailRow,
  context: { suiteId: number; sectionIds: ReadonlyMap<number, number>; source: string },
): Mapped {
  const name = text(section.name);
  if (!name) throw new MappingError(`TestRail section ${section.id} has no name`);
  const unmapped: UnmappedField[] = [];
  const depth = integer(section.depth) ?? 0;
  if (depth >= MAX_SECTION_LEVELS) {
    throw new MappingError(
      `TestRail section ${section.id} is at depth ${depth}; the schema allows ` +
        `${MAX_SECTION_LEVELS} levels`,
    );
  }
  return {
    row: {
      suite_id: context.suiteId,
      parent_id: reference(context.sectionIds, section.parent_id, "parent_id", unmapped),
      depth,
      display_order: integer(section.display_order) ?? 0,
      name,
      description: text(section.description),
      source: context.source,
      source_id: section.id,
    },
    unmapped,
  };
}

export type CaseMapContext = {
  suiteId: number;
  source: string;
  sectionIds: ReadonlyMap<number, number>;
  milestoneIds: ReadonlyMap<number, number>;
  userIds: ReadonlyMap<number, number>;
  /* TestRail id -> ours, built from get_priorities / get_case_types /
     get_templates by label. An entry missing means the label did not match
     and the column imports as NULL. */
  priorityIds: ReadonlyMap<number, number>;
  typeIds: ReadonlyMap<number, number>;
  templateIds: ReadonlyMap<number, number>;
};

export function mapCase(testrailCase: TestRailRow, context: CaseMapContext): Mapped {
  const title = text(testrailCase.title);
  if (!title) throw new MappingError(`TestRail case ${testrailCase.id} has no title`);
  const unmapped: UnmappedField[] = [];

  const custom = customBag(testrailCase);
  const createdOn = integer(testrailCase.created_on) ?? nowSecondsForImport();
  const templateId = lookupLabelled(
    context.templateIds,
    testrailCase.template_id,
    "template_id",
    unmapped,
  );

  return {
    row: {
      section_id: reference(context.sectionIds, testrailCase.section_id, "section_id", unmapped),
      suite_id: context.suiteId,
      title,
      // template_id is NOT NULL; text is TestRail's own default template.
      template_id: templateId ?? CASE_TEMPLATE.text,
      type_id: lookupLabelled(context.typeIds, testrailCase.type_id, "type_id", unmapped),
      priority_id: lookupLabelled(
        context.priorityIds,
        testrailCase.priority_id,
        "priority_id",
        unmapped,
      ),
      refs: text(testrailCase.refs),
      estimate: text(testrailCase.estimate),
      milestone_id: reference(
        context.milestoneIds,
        testrailCase.milestone_id,
        "milestone_id",
        unmapped,
      ),
      custom: Object.keys(custom).length > 0 ? JSON.stringify(custom) : null,
      created_by: reference(context.userIds, testrailCase.created_by, "created_by", unmapped),
      created_on: createdOn,
      updated_by: reference(context.userIds, testrailCase.updated_by, "updated_by", unmapped),
      /* null, not the clock: the caller keeps whatever is already stored.
         A date invented from "now" differs on every import and makes the
         row report itself as changed forever. */
      updated_on: integer(testrailCase.updated_on),
      source: context.source,
      source_id: testrailCase.id,
    },
    unmapped,
  };
}

/*
  A label that did not match is a NULL plus a report line, same as the CSV
  path: the operator renames the priority in our constants and re-runs,
  rather than discovering months later that everything is "other".
*/
function lookupLabelled(
  ids: ReadonlyMap<number, number>,
  sourceId: unknown,
  field: string,
  unmapped: UnmappedField[],
): number | null {
  const wanted = integer(sourceId);
  if (wanted === null || wanted === 0) return null;
  const resolved = ids.get(wanted);
  if (resolved === undefined) {
    unmapped.push({ field, value: `TestRail id ${wanted} has no label we recognise` });
    return null;
  }
  return resolved;
}

/*
  TestRail's `custom_*` keys lose the prefix and land in the `custom` JSON
  column verbatim. Two of them are renamed, because phase 2 already chose
  names for the same data and the CSV path already writes them:
  `custom_steps` is the text-template steps field (`steps_text`) and
  `custom_steps_separated` is the step table (`steps`).
*/
const CUSTOM_FIELD_ALIASES: Record<string, string> = {
  steps: "steps_text",
  steps_separated: "steps",
};

export function stripCustomPrefix(name: string): string {
  const stripped = name.startsWith("custom_") ? name.slice("custom_".length) : name;
  return CUSTOM_FIELD_ALIASES[stripped] ?? stripped;
}

function customBag(row: TestRailRow): Record<string, unknown> {
  const custom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("custom_")) continue;
    if (value === null || value === undefined || value === "") continue;
    custom[stripCustomPrefix(key)] = value;
  }
  return custom;
}

export function mapPlan(
  plan: TestRailRow,
  context: { projectId: number; milestoneIds: ReadonlyMap<number, number>; source: string },
): Mapped {
  const name = text(plan.name);
  if (!name) throw new MappingError(`TestRail plan ${plan.id} has no name`);
  const unmapped: UnmappedField[] = [];
  return {
    row: {
      project_id: context.projectId,
      name,
      description: text(plan.description),
      milestone_id: reference(context.milestoneIds, plan.milestone_id, "milestone_id", unmapped),
      is_completed: flag(plan.is_completed),
      created_on: integer(plan.created_on) ?? nowSecondsForImport(),
      source: context.source,
      source_id: plan.id,
    },
    unmapped,
  };
}

export type RunMapContext = {
  projectId: number;
  suiteIds: ReadonlyMap<number, number>;
  planIds: ReadonlyMap<number, number>;
  milestoneIds: ReadonlyMap<number, number>;
  source: string;
};

export function mapRun(run: TestRailRow, context: RunMapContext): Mapped {
  const name = text(run.name);
  if (!name) throw new MappingError(`TestRail run ${run.id} has no name`);
  const unmapped: UnmappedField[] = [];

  const suiteId = reference(context.suiteIds, run.suite_id, "suite_id", unmapped);
  if (suiteId === null) {
    throw new MappingError(
      `TestRail run ${run.id} names suite ${run.suite_id}, which was not imported`,
    );
  }
  return {
    row: {
      project_id: context.projectId,
      suite_id: suiteId,
      plan_id: reference(context.planIds, run.plan_id, "plan_id", unmapped),
      milestone_id: reference(context.milestoneIds, run.milestone_id, "milestone_id", unmapped),
      name,
      description: text(run.description),
      // TestRail's configuration groups are stored as the label string so the
      // import is lossless; structured groups are deferred (plan section 7).
      config: text(run.config),
      include_all: flag(run.include_all),
      is_completed: flag(run.is_completed),
      created_on: integer(run.created_on) ?? nowSecondsForImport(),
      source: context.source,
      source_id: run.id,
    },
    unmapped,
  };
}

export function mapTest(
  test: TestRailRow,
  context: {
    runId: number;
    caseIds: ReadonlyMap<number, number>;
    userIds: ReadonlyMap<number, number>;
    knownStatusIds: ReadonlySet<number>;
    source: string;
  },
): Mapped {
  const title = text(test.title);
  if (!title) throw new MappingError(`TestRail test ${test.id} has no title`);
  const unmapped: UnmappedField[] = [];

  const statusId = integer(test.status_id) ?? RESULT_STATUS.untested;
  if (!context.knownStatusIds.has(statusId)) {
    throw new MappingError(
      `TestRail test ${test.id} has status ${statusId}, which was not imported. ` +
        `Import statuses before tests.`,
    );
  }
  return {
    row: {
      run_id: context.runId,
      case_id: reference(context.caseIds, test.case_id, "case_id", unmapped),
      title_snapshot: title,
      status_id: statusId,
      assigned_to: reference(context.userIds, test.assignedto_id, "assignedto_id", unmapped),
      source: context.source,
      source_id: test.id,
    },
    unmapped,
  };
}

export function mapResult(
  result: TestRailRow,
  context: {
    testIds: ReadonlyMap<number, number>;
    userIds: ReadonlyMap<number, number>;
    knownStatusIds: ReadonlySet<number>;
    source: string;
  },
): Mapped {
  const unmapped: UnmappedField[] = [];
  const testId = reference(context.testIds, result.test_id, "test_id", unmapped);
  if (testId === null) {
    throw new MappingError(
      `TestRail result ${result.id} names test ${result.test_id}, which was not imported`,
    );
  }

  /*
    A status we do not have is a hard failure, never a quiet fall back to
    untested: untested is the absence of a result, and writing it here would
    turn a recorded fact into a missing one.
  */
  const statusId = integer(result.status_id);
  if (statusId !== null && !context.knownStatusIds.has(statusId)) {
    throw new MappingError(
      `TestRail result ${result.id} has status ${statusId}, which was not imported`,
    );
  }
  const custom = customBag(result);

  /*
    TestRail's "comment only" row carries no verdict. It is still history
    and is kept, but it is the one place a result lands holding untested -
    which everywhere else in this product means "no result exists" - so it
    is reported rather than written quietly.
  */
  if (statusId === null) {
    unmapped.push({ field: "status_id", value: "comment-only result, stored as untested" });
  }

  return {
    row: {
      test_id: testId,
      status_id: statusId ?? RESULT_STATUS.untested,
      comment: text(result.comment),
      version: text(result.version),
      // Stored verbatim: "1m 45s" is the user's value, and parsing it to
      // seconds on the way in is how data gets mangled.
      elapsed: text(result.elapsed),
      defects: text(result.defects),
      assigned_to: reference(context.userIds, result.assignedto_id, "assignedto_id", unmapped),
      custom: Object.keys(custom).length > 0 ? JSON.stringify(custom) : null,
      created_by: reference(context.userIds, result.created_by, "created_by", unmapped),
      created_on: integer(result.created_on) ?? nowSecondsForImport(),
      source: context.source,
      source_id: result.id,
    },
    unmapped,
  };
}

/*
  TestRail's priorities, case types and templates are instance-specific - an
  admin renames and reorders them - so they translate by label into our own
  constants, and the result is a TestRail id -> our id map the case mapper
  uses. A label with no match is simply absent from the map, and every case
  that referenced it gets one report line.
*/
export function labelledIdMap(
  rows: readonly TestRailRow[],
  toOurId: (label: string) => number | null,
): { ids: Map<number, number>; unmatched: { id: number; label: string }[] } {
  const ids = new Map<number, number>();
  const unmatched: { id: number; label: string }[] = [];
  for (const row of rows) {
    const label = text(row.name) ?? text(row.label);
    const ourId = label === null ? null : toOurId(label);
    if (ourId === null) {
      unmatched.push({ id: row.id, label: label ?? "" });
      continue;
    }
    ids.set(row.id, ourId);
  }
  return { ids, unmatched };
}
