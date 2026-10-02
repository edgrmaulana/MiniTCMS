"use client";

import type { RunProgress, StatusRow } from "@/lib/format";

/*
  The stacked bar, the two numbers that must travel together, and the labelled
  breakdown that keeps identity off colour alone.

  A pass rate with no untested count beside it is how a run that is 2% executed
  reads as "100% passing" (phase 3, section 2), so PassRate renders both or
  neither. Colours come from `statuses.color`, which means a custom status a
  TestRail import brought in looks like itself with no code change here - and
  because an imported colour is whatever that instance chose, every segment is
  also named in the legend rather than left to be told apart by hue.
*/
export function StatusBar({
  progress,
  statuses,
}: {
  progress: RunProgress;
  statuses: readonly StatusRow[];
}) {
  const segments = orderedSegments(progress, statuses);

  return (
    <div className="flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-[rgba(27,35,53,0.8)]">
      {segments.map((segment) => (
        <span
          key={segment.id}
          title={`${segment.label}: ${segment.total}`}
          className="first:rounded-l-full last:rounded-r-full"
          style={{
            width: `${(segment.total / Math.max(progress.total, 1)) * 100}%`,
            backgroundColor: segment.color,
          }}
        />
      ))}
    </div>
  );
}

export function PassRate({ progress }: { progress: RunProgress }) {
  return (
    <p className="flex items-baseline gap-2 text-xs">
      <span className="text-ink">
        {progress.passRate === null
          ? "Nothing executed"
          : `${Math.round(progress.passRate * 100)}% passing`}
      </span>
      <span className="text-muted">
        {progress.untested} untested of {progress.total}
      </span>
    </p>
  );
}

export function StatusLegend({
  progress,
  statuses,
}: {
  progress: RunProgress;
  statuses: readonly StatusRow[];
}) {
  const segments = orderedSegments(progress, statuses);
  if (segments.length === 0) return null;

  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {segments.map((segment) => (
        <li key={segment.id} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: segment.color }}
          />
          {segment.label} {segment.total}
        </li>
      ))}
    </ul>
  );
}

// Status id order, the same order the keyboard map hands out its digits, so
// the bar and the keys agree on which status is which.
function orderedSegments(progress: RunProgress, statuses: readonly StatusRow[]) {
  const byId = new Map(statuses.map((status) => [status.id, status]));
  return [...progress.counts]
    .sort((left, right) => left.status_id - right.status_id)
    .map((count) => {
      const status = byId.get(count.status_id);
      return {
        id: count.status_id,
        label: status?.label ?? `#${count.status_id}`,
        color: status?.color ?? "#3a4459",
        total: count.total,
      };
    });
}
