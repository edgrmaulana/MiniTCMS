"use client";

import type { ImportReport } from "@/lib/migrate/report";

/*
  The report is the deliverable of a migration, so it gets a screen rather than
  a toast (plan/05-ui.md). Nothing here summarises away a count: what was
  fetched, what landed, what this tool decided not to understand, and how many
  entries were dropped from each list to keep the JSON bounded.

  `ImportReport` is a type-only import - it compiles to nothing, so this stays
  a client component with no server module behind it.
*/
export default function ImportReportView({ report }: { report: ImportReport }) {
  const entities = Object.entries(report.counts);

  return (
    <div className="flex flex-col gap-4">
      <table className="grid-table sheet">
        <thead>
          <tr>
            <th scope="col">Entity</th>
            <th scope="col" className="w-20">Fetched</th>
            <th scope="col" className="w-20">Inserted</th>
            <th scope="col" className="w-20">Updated</th>
            <th scope="col" className="w-24">Unchanged</th>
            <th scope="col" className="w-20">Skipped</th>
          </tr>
        </thead>
        <tbody>
          {entities.map(([entity, counts]) => (
            <tr key={entity}>
              <td>{entity}</td>
              <td>{counts?.fetched ?? 0}</td>
              <td>{counts?.inserted ?? 0}</td>
              <td>{counts?.updated ?? 0}</td>
              <td className="text-muted">{counts?.unchanged ?? 0}</td>
              <td className={counts?.skipped ? "text-alert" : "text-muted"}>
                {counts?.skipped ?? 0}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {entities.length === 0 ? <p className="text-sm text-muted">No counts recorded.</p> : null}

      {report.notes.length > 0 ? (
        <section className="flex flex-col gap-1">
          <p className="label">Notes</p>
          <ul className="flex flex-col gap-1 text-sm text-muted">
            {report.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <Entries
        title="Errors"
        dropped={report.truncated.errors}
        rows={report.errors.map((entry) => ({
          key: `${entry.entity}-${entry.sourceId}-${entry.message}`,
          head: `${entry.entity} ${entry.sourceId ?? "-"}`,
          body: entry.message,
        }))}
      />
      <Entries
        title="Skipped"
        dropped={report.truncated.skipped}
        rows={report.skipped.map((entry) => ({
          key: `${entry.entity}-${entry.sourceId}-${entry.reason}`,
          head: `${entry.entity} ${entry.sourceId ?? "-"}`,
          body: entry.reason,
        }))}
      />
      <Entries
        title="Unmapped fields"
        dropped={report.truncated.unmapped}
        rows={report.unmapped.map((entry) => ({
          key: `${entry.entity}-${entry.sourceId}-${entry.field}`,
          head: `${entry.entity} ${entry.sourceId ?? "-"} / ${entry.field}`,
          body: entry.value,
        }))}
      />

      {Object.keys(report.durations).length > 0 ? (
        <details className="sheet px-3 py-2">
          <summary className="label cursor-pointer">Durations</summary>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-muted">
            {Object.entries(report.durations).map(([stage, ms]) => (
              <li key={stage}>
                {stage}: {ms}ms
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

// Collapsed by default, counted in the summary: a migration with 4,000
// unmapped fields must say 4,000 without pushing everything else off screen.
function Entries({
  title,
  rows,
  dropped,
}: {
  title: string;
  rows: readonly { key: string; head: string; body: string }[];
  dropped: number;
}) {
  if (rows.length === 0 && dropped === 0) return null;
  return (
    <details className="sheet px-3 py-2">
      <summary className="label cursor-pointer">
        {title}: {rows.length + dropped}
        {dropped > 0 ? ` (${dropped} not listed)` : ""}
      </summary>
      <ul className="mt-2 flex flex-col gap-1 text-xs">
        {rows.map((row) => (
          <li key={row.key}>
            <span className="text-muted">{row.head}</span> {row.body}
          </li>
        ))}
      </ul>
    </details>
  );
}
