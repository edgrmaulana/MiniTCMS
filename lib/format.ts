// Shared types and constants. Imported by client components as well as the
// server, so nothing here may touch node: builtins or the database.

export const USER_ROLES = ["admin", "lead", "tester"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
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
  Levels, not a maximum depth value: `depth` is 0-indexed, so 6 levels means
  depths 0 through 5. Named this way because `depth <= MAX_SECTION_DEPTH` is
  the guard everyone writes by reflex, and with a depth-named constant that
  guard is off by one against the CHECK.
*/
export const MAX_SECTION_LEVELS = 6;

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

export type UserRow = {
  id: number;
  email: string;
  name: string | null;
  role: UserRole;
  is_active: number;
  password_hash: string | null;
  created_on: number;
};

export type SessionUser = {
  userId: number;
  email: string;
  name: string | null;
  role: UserRole;
  expiresOn: number;
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

export type ListResult<Row> = {
  rows: Row[];
  total: number;
  page: number;
  limit: number;
};
