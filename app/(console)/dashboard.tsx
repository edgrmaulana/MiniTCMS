"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  formatTimestamp,
  type ActivityRow,
  type ListResult,
  type ProjectOverview,
  type ProjectRow,
  type RunProgress,
  type RunRow,
  type StatusRow,
} from "@/lib/format";
import { fetchJson } from "../fetch-json";
import { PassRate, StatusBar, StatusLegend } from "./runs/status-bar";

type ProjectWithOverview = ProjectRow & { overview: ProjectOverview };
type RunWithProgress = RunRow & { progress: RunProgress };

/*
  Every number on this screen comes from a SQL aggregate and arrives with a
  line of plain language under it. Two reasons: a test report that cannot be
  read by the person who has to act on it is decoration, and a rate with no
  denominator in sight is how reports lie.
*/
export default function Dashboard() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId");
  const [project, setProject] = useState<ProjectWithOverview | null>(null);
  const [runs, setRuns] = useState<RunWithProgress[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [statuses, setStatuses] = useState<StatusRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    fetchJson<{ rows: StatusRow[] }>("/api/statuses")
      .then((result) => {
        if (current) setStatuses(result.rows);
      })
      .catch((reason: Error) => {
        if (current) setError(reason.message);
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let current = true;
    Promise.all([
      fetchJson<ProjectWithOverview>(`/api/projects/${projectId}`),
      // Open runs only, filtered in SQL: a page of 25 runs that happen to
      // include some closed ones is not a page of open runs.
      fetchJson<ListResult<RunWithProgress>>(
        `/api/runs?projectId=${projectId}&isCompleted=false&limit=25`,
      ),
      fetchJson<{ rows: ActivityRow[] }>(`/api/projects/${projectId}/activity?limit=10`),
    ])
      .then(([projectResult, runResult, activityResult]) => {
        if (!current) return;
        setError(null);
        setProject(projectResult);
        setRuns(runResult.rows);
        setActivity(activityResult.rows);
      })
      .catch((reason: Error) => {
        if (current) setError(reason.message);
      });
    return () => {
      current = false;
    };
  }, [projectId]);

  if (!projectId) {
    return (
      <section className="mx-auto flex max-w-xl flex-col gap-3 px-8 py-16">
        <p className="label">Dashboard</p>
        <p className="display text-2xl">Choose a project in the rail.</p>
        <p className="text-sm text-muted">
          Everything on this screen is scoped to one project: its open runs, how much of
          it has been executed, and what was recorded last.
        </p>
      </section>
    );
  }

  if (error && !project) {
    return (
      <p role="alert" className="px-8 py-16 text-sm text-alert">
        {error}
      </p>
    );
  }
  if (!project) return <p className="px-8 py-16 text-sm text-muted">Loading dashboard</p>;

  const { overview } = project;
  const statusById = new Map(statuses.map((status) => [status.id, status]));

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4">
        <p className="label">Dashboard</p>
        <h1 className="display text-xl">{project.name}</h1>
        {project.source ? (
          <span className="pill text-muted">
            {project.source} #{project.source_id}
          </span>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Link href={`/cases?projectId=${project.id}`} className="chip">
            Cases
          </Link>
          <Link href={`/runs?projectId=${project.id}`} className="chip">
            Runs
          </Link>
        </div>
      </header>

      {project.announcement ? (
        <p className="border-b border-line px-6 py-2 text-sm text-muted">{project.announcement}</p>
      ) : null}

      {error ? (
        <p role="alert" className="border-b border-alert px-6 py-2 text-sm text-alert">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="flex max-w-5xl flex-col gap-6">
          <section className="grid gap-3 md:grid-cols-3">
            <Tile
              value={String(overview.openRuns)}
              label="Open runs"
              explanation={`${overview.totalRuns} runs exist in this project; these are the ones still accepting results.`}
            />
            <Tile
              value={
                overview.progress.passRate === null
                  ? "Nothing executed"
                  : `${Math.round(overview.progress.passRate * 100)}%`
              }
              label="Passing"
              explanation={
                overview.progress.passRate === null
                  ? "No test in this project has a recorded result yet, which is not the same as nothing passing."
                  : `${overview.progress.passed} passed out of the ${overview.progress.executed} tests that reached a final status. Untested and retest are not in the denominator.`
              }
            />
            <Tile
              value={String(overview.progress.untested)}
              label="Untested"
              explanation={`Of ${overview.progress.total} tests across every run, this many have no result at all.`}
            />
          </section>

          <section className="flex flex-col gap-2">
            <p className="label">Across every run in this project</p>
            <StatusBar progress={overview.progress} statuses={statuses} />
            <StatusLegend progress={overview.progress} statuses={statuses} />
          </section>

          <section className="flex flex-col gap-2">
            <p className="label">Open runs</p>
            {/* The tile above counts every open run in SQL; this list is one
                page of 25. When they disagree the list says which it is. */}
            {overview.openRuns > runs.length ? (
              <p className="text-xs text-muted">
                Showing {runs.length} of {overview.openRuns} open runs.{" "}
                <Link href={`/runs?projectId=${project.id}`} className="hover:text-aurora">
                  All runs
                </Link>
              </p>
            ) : null}
            {runs.length === 0 ? (
              <p className="text-sm text-muted">
                No open run. Closed runs stay readable under Runs.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {runs.map((run) => (
                  <li key={run.id} className="sheet px-4 py-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <Link href={`/runs/${run.id}`} className="text-sm hover:text-aurora">
                        {run.name}
                      </Link>
                      <p className="ml-auto text-xs text-muted">{formatTimestamp(run.created_on)}</p>
                    </div>
                    <div className="mt-2 flex flex-col gap-1">
                      <StatusBar progress={run.progress} statuses={statuses} />
                      <PassRate progress={run.progress} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <p className="label">Recent activity</p>
            <p className="text-xs text-muted">
              The last ten results recorded in this project. Results are the only history
              there is - nothing else is logged, and nothing here can be edited.
            </p>
            {activity.length === 0 ? (
              <p className="text-sm text-muted">Nothing has been recorded in this project yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {activity.map((entry) => (
                  <li key={entry.id} className="sheet flex flex-wrap items-baseline gap-2 px-3 py-2 text-sm">
                    <span
                      className="pill"
                      style={{ color: statusById.get(entry.status_id)?.color ?? undefined }}
                    >
                      {statusById.get(entry.status_id)?.label ?? `#${entry.status_id}`}
                    </span>
                    <Link href={`/runs/${entry.run_id}`} className="truncate hover:text-aurora">
                      {entry.title_snapshot}
                    </Link>
                    <span className="text-xs text-muted">in {entry.run_name}</span>
                    <span className="ml-auto text-xs text-muted">
                      {entry.author ? `${entry.author}, ` : ""}
                      {formatTimestamp(entry.created_on)}
                    </span>
                    {entry.comment ? (
                      <p className="w-full whitespace-pre-wrap text-xs text-muted">{entry.comment}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// A number worth reading is a number with its sentence attached.
function Tile({
  value,
  label,
  explanation,
}: {
  value: string;
  label: string;
  explanation: string;
}) {
  return (
    <div className="sheet flex flex-col gap-1 px-4 py-3">
      <p className="label">{label}</p>
      <p className="display text-3xl">{value}</p>
      <p className="text-xs text-muted">{explanation}</p>
    </div>
  );
}
