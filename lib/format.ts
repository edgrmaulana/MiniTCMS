// Shared types and constants. Imported by client components as well as the
// server, so nothing here may touch node: builtins or the database.

export const USER_ROLES = ["admin", "lead", "tester"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}

/*
  The three roles are a ladder, not a set of overlapping permissions: admin can
  do everything lead can, lead everything tester can. Ranked here so a route
  states the floor it needs ("lead or better") instead of listing the roles
  that clear it - a list is the thing somebody forgets to extend when a fourth
  role lands, and forgetting it fails open.
*/
const ROLE_RANK: Record<UserRole, number> = { tester: 1, lead: 2, admin: 3 };

export function roleAtLeast(role: UserRole, minimum: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/*
  TestRail's five built-in result statuses, with TestRail's own ids. Pinned
  deliberately so the phase 4 import maps 1:1 and never has to translate the
  common case. Custom statuses start at 6, the same place TestRail starts them.
*/
export const RESULT_STATUS = {
  passed: 1,
  blocked: 2,
  untested: 3,
  retest: 4,
  failed: 5,
} as const;

export type ResultStatusId = (typeof RESULT_STATUS)[keyof typeof RESULT_STATUS];

export const FIRST_CUSTOM_STATUS_ID = 6;

/*
  Failing or blocking without saying why leaves somebody reproducing it from
  scratch tomorrow. The rule lives here because two places need it: lib/db.ts
  enforces it on every write, including the CI reporter's, and the run screen
  reads it to open the comment box instead of writing straight through.
*/
export const COMMENT_REQUIRED_STATUS_IDS: readonly number[] = [
  RESULT_STATUS.failed,
  RESULT_STATUS.blocked,
];

export function needsComment(statusId: number): boolean {
  return COMMENT_REQUIRED_STATUS_IDS.includes(statusId);
}

export const BUILT_IN_STATUSES = [
  { id: RESULT_STATUS.passed, systemName: "passed", label: "Passed", color: "#2fe0a8", isUntested: 0, isFinal: 1 },
  { id: RESULT_STATUS.blocked, systemName: "blocked", label: "Blocked", color: "#8793ab", isUntested: 0, isFinal: 1 },
  { id: RESULT_STATUS.untested, systemName: "untested", label: "Untested", color: "#3a4459", isUntested: 1, isFinal: 0 },
  { id: RESULT_STATUS.retest, systemName: "retest", label: "Retest", color: "#f0b429", isUntested: 0, isFinal: 0 },
  { id: RESULT_STATUS.failed, systemName: "failed", label: "Failed", color: "#ff5d8f", isUntested: 0, isFinal: 1 },
] as const;

/*
  MiniTCMS's own priority and type ids. TestRail's are instance-specific - an
  admin can add, rename and reorder them - so these are NOT assumed to match.
  The import reads get_priorities and get_case_types and translates through
  lib/migrate/map.ts. See plan/04-testrail-migration.md.
*/
export const CASE_PRIORITY = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
} as const;

export const CASE_TYPE = {
  functional: 1,
  regression: 2,
  smoke: 3,
  performance: 4,
  security: 5,
  other: 6,
} as const;

/*
  Display labels, derived from the id maps above rather than written out a
  second time: a type added to CASE_TYPE cannot leave a table rendering a bare
  number. An id with no name here - a custom TestRail priority the import
  mapped past 4 - renders as its id rather than as nothing.
*/
function labelsFor(ids: Record<string, number>): Record<number, string> {
  return Object.fromEntries(
    Object.entries(ids).map(([name, id]) => [id, name[0].toUpperCase() + name.slice(1)]),
  );
}

export const CASE_PRIORITY_LABELS = labelsFor(CASE_PRIORITY);

export const CASE_TYPE_LABELS = labelsFor(CASE_TYPE);

export function labelFor(labels: Record<number, string>, id: number | null): string {
  if (id === null) return "-";
  return labels[id] ?? `#${id}`;
}

// TestRail's documented suite_mode values; these are fixed, not configurable.
export const SUITE_MODE = {
  single: 1,
  singleWithBaselines: 2,
  multi: 3,
} as const;

export type SuiteMode = (typeof SUITE_MODE)[keyof typeof SUITE_MODE];

// Which fields a case shows. Matched to the shape phase 2 stores in `custom`.
export const CASE_TEMPLATE = {
  text: 1,
  steps: 2,
  exploratory: 3,
} as const;

/*
  Levels, not a maximum depth value: `depth` is 0-indexed, so 64 levels means
  depths 0 through 63. Named this way because `depth <= MAX_SECTION_DEPTH` is
  the guard everyone writes by reflex, and with a depth-named constant that
  guard is off by one against the CHECK.

  This is a runaway bound, not a product opinion about how deep a tree should
  be. It was 6, which a real TestRail export broke on its first outing: that
  instance nests sections seven deep and 25 of its 1123 cases live down there.
  Depth costs nothing to read - the tree CTE walks nodes, not levels, so a
  suite's read is the same work however it is shaped: that instance's 203
  sections over seven levels read in 369us, and a pathological 64-level chain
  in 213us, both off idx_sections_suite for the seed and idx_sections_parent
  for the recursive step. The write paths cannot build a cycle either, because
  a new section hangs off a parent that already exists and a move refuses a
  new parent inside the subtree being moved. What is left to protect against
  is a hand-edited or corrupted `parent_id`, and 64 stops that spinning
  without ever telling a real migration no.

  The CHECK on `sections.depth` and the `level` bound in every recursive read
  must stay this same number. A row deeper than the read bound would be
  invisible in a tree read rather than rejected on the way in, which is the
  one failure here nobody would see.
*/
export const MAX_SECTION_LEVELS = 64;

/*
  How many levels of indentation a screen draws before it stops stepping in.
  The tree itself may nest to MAX_SECTION_LEVELS; indenting that far would
  walk a section name off the side of the panel, so the visual step stops
  here and deeper rows sit at the same offset as their ancestors.
*/
export const MAX_TREE_INDENT_LEVELS = 8;

export function treeIndentLevel(depth: number): number {
  return Math.min(depth, MAX_TREE_INDENT_LEVELS);
}

// What an attachment can hang off. Interpolated into the CHECK in lib/db.ts.
export const ATTACHMENT_ENTITIES = ["case", "test", "result"] as const;

export type AttachmentEntity = (typeof ATTACHMENT_ENTITIES)[number];

export const PAGE_SIZES = [25, 50, 100] as const;

export const DEFAULT_PAGE_SIZE = PAGE_SIZES[0];

/*
  A ceiling, so an absurd ?page= is an empty result rather than a 500: an
  unbounded page multiplies into an offset SQLite cannot bind, and Infinity
  raises "datatype mismatch" instead of returning no rows.
*/
export const MAX_PAGE = 1_000_000;

export function clampPageSize(value: unknown): number {
  const requested = Number(value);
  // Snapped rather than clamped: an arbitrary limit is a way to ask for the
  // whole table one request at a time.
  return (PAGE_SIZES as readonly number[]).includes(requested)
    ? requested
    : DEFAULT_PAGE_SIZE;
}

export function clampPage(value: unknown): number {
  const requested = Math.floor(Number(value));
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(requested, MAX_PAGE);
}

// Clamps both sides itself rather than trusting the caller to have done it.
export function offsetFor(page: unknown, limit: unknown): number {
  return (clampPage(page) - 1) * clampPageSize(limit);
}

/*
  TestRail's custom field types, kept at its own names so the import is a
  copy. A definition whose type is not in here still imports: the value is
  preserved verbatim and reported, because losing a field is worse than
  storing one we cannot render yet.
*/
export const CASE_FIELD_TYPES = [
  "string",
  "text",
  "integer",
  "dropdown",
  "multiselect",
  "checkbox",
  "date",
  "user",
  "steps",
] as const;

export type CaseFieldType = (typeof CASE_FIELD_TYPES)[number];

export function isCaseFieldType(value: string): value is CaseFieldType {
  return (CASE_FIELD_TYPES as readonly string[]).includes(value);
}

export type UserRow = {
  id: number;
  email: string;
  name: string | null;
  role: UserRole;
  is_active: number;
  password_hash: string | null;
  created_on: number;
};

/*
  A user as every screen is allowed to see one: no password hash, no session.
  Rows come from listUsers in lib/db.ts.
*/
export type AssignableUser = {
  id: number;
  email: string;
  name: string | null;
  role: UserRole;
};

/*
  Who the request is, however it proved it. A cookie session and an API key
  land in the same shape on purpose: a route asks "which user, which role" and
  never has to branch on how they signed in, so a key can never reach a path a
  session cannot.
*/
export type SessionUser = {
  userId: number;
  email: string;
  name: string | null;
  role: UserRole;
  // Null for an API key: it lives until somebody revokes it.
  expiresOn: number | null;
  // Set only on the key path, so rate limiting and last-used can find the row.
  apiKeyId?: number;
};

// An API key as it may be shown. The hash is not in here, and nothing joins
// it in later: the secret is printed once, at creation, and never again.
export type ApiKeyRow = {
  id: number;
  user_id: number;
  email: string;
  name: string;
  created_on: number;
  last_used_on: number | null;
  revoked_on: number | null;
};

// Rows carry snake_case straight from SQLite; nothing renames on the way out.
export type ProjectRow = {
  id: number;
  name: string;
  announcement: string | null;
  suite_mode: SuiteMode;
  is_completed: number;
  created_on: number;
  source: string | null;
  source_id: number | null;
};

export type SuiteRow = {
  id: number;
  project_id: number;
  name: string;
  description: string | null;
  is_baseline: number;
  baseline_of: number | null;
  source: string | null;
  source_id: number | null;
};

export type SectionRow = {
  id: number;
  suite_id: number;
  parent_id: number | null;
  depth: number;
  display_order: number;
  name: string;
  description: string | null;
  source: string | null;
  source_id: number | null;
};

/*
  One row of sectionTree() in lib/db.ts. Declared here rather than there
  because the tree is rendered by a client component, and nothing in app/ may
  import the database module.
*/
export type SectionTreeRow = {
  id: number;
  parent_id: number | null;
  depth: number;
  display_order: number;
  name: string;
  description: string | null;
  case_count: number;
};

export type CaseRow = {
  id: number;
  section_id: number | null;
  suite_id: number;
  title: string;
  template_id: number;
  type_id: number | null;
  priority_id: number | null;
  refs: string | null;
  estimate: string | null;
  milestone_id: number | null;
  custom: string | null;
  is_deleted: number;
  created_by: number | null;
  created_on: number;
  updated_by: number | null;
  updated_on: number;
  source: string | null;
  source_id: number | null;
};

export type RunRow = {
  id: number;
  project_id: number;
  suite_id: number;
  plan_id: number | null;
  milestone_id: number | null;
  name: string;
  description: string | null;
  config: string | null;
  include_all: number;
  is_completed: number;
  created_on: number;
  source: string | null;
  source_id: number | null;
};

export type TestRow = {
  id: number;
  run_id: number;
  case_id: number | null;
  title_snapshot: string;
  status_id: number;
  assigned_to: number | null;
  source: string | null;
  source_id: number | null;
};

export type ResultRow = {
  id: number;
  test_id: number;
  status_id: number;
  comment: string | null;
  version: string | null;
  elapsed: string | null;
  defects: string | null;
  assigned_to: number | null;
  custom: string | null;
  created_by: number | null;
  created_on: number;
  source: string | null;
  source_id: number | null;
};

export type CaseFieldRow = {
  id: number;
  system_name: string;
  label: string;
  type: string;
  is_global: number;
  configs: string | null;
  source: string | null;
  source_id: number | null;
};

export class CaseFieldError extends Error {}

/*
  Validates a `custom` bag against the definitions in `case_fields`. Throws on
  a value that contradicts its declared type; returns the keys that have no
  definition rather than throwing, because the two callers want opposite
  things with them - the API rejects an unknown key, the TestRail import keeps
  it and reports it (AGENTS.md rule 4).
*/
export function validateCustom(
  definitions: readonly CaseFieldRow[],
  values: Record<string, unknown>,
): { custom: Record<string, unknown>; unknownKeys: string[] } {
  const byName = new Map(definitions.map((definition) => [definition.system_name, definition]));
  const custom: Record<string, unknown> = {};
  const unknownKeys: string[] = [];

  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    const definition = byName.get(name);
    if (!definition) {
      unknownKeys.push(name);
      custom[name] = value;
      continue;
    }
    custom[name] = coerceFieldValue(definition, value);
  }
  return { custom, unknownKeys };
}

function coerceFieldValue(definition: CaseFieldRow, value: unknown): unknown {
  const fail = (wanted: string): never => {
    throw new CaseFieldError(
      `Field "${definition.system_name}" wants ${wanted}, got ${JSON.stringify(value)}`,
    );
  };

  switch (definition.type) {
    case "string":
    case "text":
      return typeof value === "string" ? value : fail("a string");
    case "integer":
      return Number.isInteger(value) ? value : fail("an integer");
    case "checkbox":
      return typeof value === "boolean" ? value : fail("true or false");
    case "date":
      // Unix seconds, same as every other timestamp in the schema.
      return Number.isInteger(value) ? value : fail("a unix timestamp in seconds");
    case "user":
      return Number.isInteger(value) ? value : fail("a user id");
    case "dropdown": {
      const allowed = allowedValues(definition);
      return allowed.includes(String(value)) ? value : fail(`one of ${allowed.join(", ")}`);
    }
    case "multiselect": {
      if (!Array.isArray(value)) return fail("an array");
      const allowed = allowedValues(definition);
      for (const entry of value) {
        if (!allowed.includes(String(entry))) return fail(`values from ${allowed.join(", ")}`);
      }
      return value;
    }
    case "steps":
      return Array.isArray(value) ? value : fail("an array of steps");
    default:
      // An unsupported type is not a reason to drop the value.
      return value;
  }
}

function allowedValues(definition: CaseFieldRow): string[] {
  if (!definition.configs) return [];
  try {
    const parsed = JSON.parse(definition.configs) as { options?: { items?: unknown } };
    const items = parsed.options?.items;
    if (Array.isArray(items)) return items.map(String);
    // TestRail ships dropdown items as a newline-separated "id, label" blob.
    if (typeof items === "string") {
      return items
        .split("\n")
        .map((line) => line.split(",")[0].trim())
        .filter(Boolean);
    }
    return [];
  } catch {
    throw new CaseFieldError(`Field "${definition.system_name}" has unreadable configs JSON`);
  }
}

export type StatusRow = {
  id: number;
  system_name: string;
  label: string;
  color: string | null;
  is_untested: number;
  is_final: number;
};

/*
  Untested is the absence of a result, not a result: it is what a test is born
  with when a run is created, and it is never written to `results`. Everything
  else can be recorded, including the custom statuses a TestRail import brings
  in at id 6 and up - which is why this asks the row rather than comparing
  against a list of four ids.
*/
export function isAssignableStatus(status: StatusRow): boolean {
  return status.is_untested === 0;
}

export type StatusCount = { status_id: number; total: number };

export type RunProgress = {
  counts: StatusCount[];
  total: number;
  executed: number;
  untested: number;
  passed: number;
  passRate: number | null;
};

/*
  One definition of a pass rate for the whole product: passed over the tests
  that reached a final status. Untested and retest are excluded from the
  denominator, and `untested` comes back alongside so no screen can render the
  percentage on its own. A run that is 2% executed and 100% passing reading as
  "100%" is the most common way a test report lies.

  Null rather than zero when nothing has been executed: zero percent passing
  and nothing run yet are different facts.
*/
export function runProgress(counts: StatusCount[], statuses: StatusRow[]): RunProgress {
  const byId = new Map(statuses.map((status) => [status.id, status]));
  let total = 0;
  let executed = 0;
  let untested = 0;
  let passed = 0;

  for (const count of counts) {
    const status = byId.get(count.status_id);
    total += count.total;
    if (!status) continue;
    if (status.is_untested === 1) untested += count.total;
    if (status.is_final === 1) executed += count.total;
    if (count.status_id === RESULT_STATUS.passed) passed += count.total;
  }
  return {
    counts,
    total,
    executed,
    untested,
    passed,
    passRate: executed === 0 ? null : passed / executed,
  };
}

/*
  TestRail writes elapsed time as "1m 45s" and we store that string verbatim,
  because rewriting a user's value during an import is how data gets mangled.
  Parsing is a display concern, and it lives here so a total on a screen and a
  total in a report cannot disagree. Unparseable input is null, not zero: a
  value we failed to read must not quietly count as no time at all.
*/
const ELAPSED_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseElapsed(elapsed: string | null | undefined): number | null {
  if (!elapsed) return null;
  const parts = elapsed.trim().toLowerCase().match(/\d+\s*[smhd]/g);
  if (!parts) return null;
  let seconds = 0;
  for (const part of parts) {
    const amount = Number.parseInt(part, 10);
    const unit = part.trim().slice(-1);
    seconds += amount * ELAPSED_UNITS[unit];
  }
  return seconds;
}

export function formatElapsed(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    remainder > 0 ? `${remainder}s` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/*
  One timestamp format for every screen, in UTC. Not the viewer's locale on
  purpose: the server renders the same string the client does, so a run's
  history does not flicker on hydration, and two testers in two timezones
  reading the same result see the same time.
*/
export function formatTimestamp(seconds: number | null | undefined): string {
  if (!seconds) return "-";
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

/*
  What the dashboard shows for one project, all of it counted in SQL by
  projectOverview in lib/db.ts. `progress` is the same shape a run carries, so
  the pass rate on the dashboard and the pass rate on a run are one function.
*/
export type ProjectOverview = {
  openRuns: number;
  totalRuns: number;
  progress: RunProgress;
};

/*
  One recorded result, with enough of its test and run to be readable on the
  dashboard. This is the activity feed: results are the only history there is,
  so recent activity is recent results and nothing else.
*/
export type ActivityRow = {
  id: number;
  status_id: number;
  created_on: number;
  comment: string | null;
  test_id: number;
  run_id: number;
  run_name: string;
  title_snapshot: string;
  author: string | null;
};

export type MilestoneRow = {
  id: number;
  project_id: number;
  parent_id: number | null;
  name: string;
  description: string | null;
  due_on: number | null;
  started_on: number | null;
  is_completed: number;
  source: string | null;
  source_id: number | null;
};

export type PlanRow = {
  id: number;
  project_id: number;
  name: string;
  description: string | null;
  milestone_id: number | null;
  is_completed: number;
  created_on: number;
  source: string | null;
  source_id: number | null;
};

export type AttachmentRow = {
  id: number;
  entity_type: AttachmentEntity;
  entity_id: number;
  filename: string;
  mime: string | null;
  size: number | null;
  storage_path: string;
  created_on: number;
  source: string | null;
  source_id: number | null;
};

/*
  Which way round a CSV export writes "10/1/2026". Not derivable from the file
  - it is a property of the exporting user's account - so it is an operator
  input on both the CLI and the import screen, which is why the list lives here
  rather than inside the CSV reader. lib/migrate/map.ts owns the validator.
*/
export const DATE_ORDERS = ["mdy", "dmy"] as const;

export type DateOrder = (typeof DATE_ORDERS)[number];

export const IMPORT_STATES = ["pending", "running", "failed", "done"] as const;

export type ImportState = (typeof IMPORT_STATES)[number];

export type ImportRunRow = {
  id: number;
  source: string;
  state: ImportState;
  started_on: number;
  finished_on: number | null;
  cursor: string | null;
  report: string | null;
};

export type ListResult<Row> = {
  rows: Row[];
  total: number;
  page: number;
  limit: number;
};
