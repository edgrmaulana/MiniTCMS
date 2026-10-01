/*
  The import report is the deliverable of a migration, not a log line. Every
  entry here answers one question an operator will ask the morning after:
  what came in, what landed, and what did this tool decide not to understand.

  Shared by both entry points - the API pipeline and the CSV reader - so the
  two produce the same document and the same reconciliation rule applies to
  both (plan/04-testrail-migration.md sections 5 and 6.8).
*/

export type ImportEntity =
  | "users"
  | "statuses"
  | "case_fields"
  | "projects"
  | "suites"
  | "sections"
  | "milestones"
  | "cases"
  | "plans"
  | "runs"
  | "tests"
  | "results"
  | "attachments";

export type EntityCounts = {
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
};

export type UnmappedEntry = {
  entity: ImportEntity;
  sourceId: number | string | null;
  field: string;
  value: string;
};

export type SkippedEntry = {
  entity: ImportEntity;
  sourceId: number | string | null;
  reason: string;
};

export type ErrorEntry = {
  entity: ImportEntity;
  sourceId: number | string | null;
  message: string;
};

export type ImportReport = {
  source: string;
  counts: Partial<Record<ImportEntity, EntityCounts>>;
  unmapped: UnmappedEntry[];
  skipped: SkippedEntry[];
  errors: ErrorEntry[];
  /* Dropped-entry tallies, so a truncated list still reports its true size. */
  truncated: { unmapped: number; skipped: number; errors: number };
  durations: Record<string, number>;
  notes: string[];
};

/*
  A 200k-case import with one unmapped field per case would otherwise hold
  200k objects in memory and write them all into import_runs.report. The
  lists are evidence, not an audit trail - the first thousand of a repeated
  problem say the same thing as the millionth, and the counter keeps the
  report honest about how many there were.
*/
export const MAX_REPORT_ENTRIES = 1000;

export function emptyReport(source: string): ImportReport {
  return {
    source,
    counts: {},
    unmapped: [],
    skipped: [],
    errors: [],
    truncated: { unmapped: 0, skipped: 0, errors: 0 },
    durations: {},
    notes: [],
  };
}

export function countsFor(report: ImportReport, entity: ImportEntity): EntityCounts {
  const existing = report.counts[entity];
  if (existing) return existing;
  const fresh: EntityCounts = { fetched: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
  report.counts[entity] = fresh;
  return fresh;
}

export function addUnmapped(report: ImportReport, entry: UnmappedEntry): void {
  if (report.unmapped.length >= MAX_REPORT_ENTRIES) {
    report.truncated.unmapped += 1;
    return;
  }
  report.unmapped.push(entry);
}

/*
  Skipping is counted as well as listed: the count feeds reconciliation, the
  list tells the operator which rows to go and look at.
*/
export function addSkipped(report: ImportReport, entry: SkippedEntry): void {
  countsFor(report, entry.entity).skipped += 1;
  if (report.skipped.length >= MAX_REPORT_ENTRIES) {
    report.truncated.skipped += 1;
    return;
  }
  report.skipped.push(entry);
}

export function addError(report: ImportReport, entry: ErrorEntry): void {
  if (report.errors.length >= MAX_REPORT_ENTRIES) {
    report.truncated.errors += 1;
    return;
  }
  report.errors.push(entry);
}

export function addNote(report: ImportReport, note: string): void {
  report.notes.push(note);
}

export function startTimer(report: ImportReport, stage: string): () => void {
  const began = Date.now();
  return () => {
    report.durations[stage] = (report.durations[stage] ?? 0) + (Date.now() - began);
  };
}

/*
  A migration that cannot account for every row has not succeeded. Returns
  the complaints rather than throwing, so the caller can print the whole
  report first and then fail - a reconciliation failure with no report to
  read is the least useful possible outcome.
*/
export function reconcile(report: ImportReport): string[] {
  const complaints: string[] = [];
  for (const [entity, counts] of Object.entries(report.counts)) {
    const accounted = counts.inserted + counts.updated + counts.unchanged + counts.skipped;
    if (accounted !== counts.fetched) {
      complaints.push(
        `${entity}: fetched ${counts.fetched} but accounted for ${accounted} ` +
          `(${counts.inserted} inserted, ${counts.updated} updated, ` +
          `${counts.unchanged} unchanged, ${counts.skipped} skipped)`,
      );
    }
  }
  return complaints;
}

export function formatReport(report: ImportReport): string {
  const lines: string[] = [`Import report (source: ${report.source})`, ""];

  lines.push("counts");
  for (const [entity, counts] of Object.entries(report.counts)) {
    lines.push(
      `  ${entity.padEnd(12)} fetched ${counts.fetched}, inserted ${counts.inserted}, ` +
        `updated ${counts.updated}, unchanged ${counts.unchanged}, skipped ${counts.skipped}`,
    );
  }

  appendSection(lines, "unmapped", report.unmapped.length, report.truncated.unmapped, () =>
    report.unmapped.map(
      (entry) => `  ${entry.entity} ${entry.sourceId ?? "-"} ${entry.field}: ${entry.value}`,
    ),
  );
  appendSection(lines, "skipped", report.skipped.length, report.truncated.skipped, () =>
    report.skipped.map((entry) => `  ${entry.entity} ${entry.sourceId ?? "-"}: ${entry.reason}`),
  );
  appendSection(lines, "errors", report.errors.length, report.truncated.errors, () =>
    report.errors.map((entry) => `  ${entry.entity} ${entry.sourceId ?? "-"}: ${entry.message}`),
  );

  if (report.notes.length > 0) {
    lines.push("", "notes");
    for (const note of report.notes) lines.push(`  ${note}`);
  }

  const stages = Object.entries(report.durations);
  if (stages.length > 0) {
    lines.push("", "duration");
    for (const [stage, millis] of stages) lines.push(`  ${stage.padEnd(12)} ${millis}ms`);
  }

  const complaints = reconcile(report);
  if (complaints.length > 0) {
    lines.push("", "RECONCILIATION FAILED");
    for (const complaint of complaints) lines.push(`  ${complaint}`);
  }
  return lines.join("\n");
}

function appendSection(
  lines: string[],
  title: string,
  shown: number,
  dropped: number,
  render: () => string[],
): void {
  if (shown === 0 && dropped === 0) return;
  const suffix = dropped > 0 ? ` (+${dropped} more not listed)` : "";
  lines.push("", `${title} (${shown + dropped})${suffix}`);
  lines.push(...render());
}
