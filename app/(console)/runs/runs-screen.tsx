"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  clampPage,
  clampPageSize,
  formatTimestamp,
  type ListResult,
  type RunProgress,
  type RunRow,
  type StatusRow,
} from "@/lib/format";
import { fetchJson } from "../../fetch-json";
import { PassRate, StatusBar } from "./status-bar";

type RunWithProgress = RunRow & { progress: RunProgress };

export default function RunsScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId");
  const page = clampPage(searchParams.get("page") ?? 1);
  const limit = clampPageSize(searchParams.get("limit") ?? DEFAULT_PAGE_SIZE);

  const [runsFetch, setRunsFetch] = useState<{ query: string; result: ListResult<RunWithProgress> } | null>(null);
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

  const query = useMemo(() => {
    if (!projectId) return null;
    return new URLSearchParams({ projectId, page: String(page), limit: String(limit) }).toString();
  }, [projectId, page, limit]);

  useEffect(() => {
    if (query === null) return;
    let current = true;
    fetchJson<ListResult<RunWithProgress>>(`/api/runs?${query}`)
      .then((result) => {
        if (!current) return;
        setError(null);
        setRunsFetch({ query, result });
      })
      .catch((reason: Error) => {
        if (current) setError(reason.message);
      });
    return () => {
      current = false;
    };
  }, [query]);

  if (!projectId) {
    return (
      <section className="mx-auto flex max-w-xl flex-col gap-3 px-8 py-16">
        <p className="label">Runs</p>
        <p className="display text-2xl">Choose a project in the rail to see its runs.</p>
      </section>
    );
  }

  const runs = runsFetch?.query === query ? runsFetch.result : null;
  const total = runs?.total ?? 0;
  const lastOnPage = Math.min(page * limit, total);

  function goToPage(next: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(next));
    router.replace(`/runs?${params.toString()}`);
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-line px-6 py-4">
        <p className="label">Runs</p>
        <p className="ml-auto text-xs text-muted">
          {total === 0 ? "No runs" : `${(page - 1) * limit + 1}-${lastOnPage} of ${total}`}
        </p>
      </header>

      {error ? (
        <p role="alert" className="border-b border-alert px-6 py-2 text-sm text-alert">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        <ul className="flex flex-col gap-2">
          {/* Open runs come first out of SQL - a closed run is history, an open
              one is somebody's afternoon. */}
          {runs?.rows.map((run) => (
            <li key={run.id} className="sheet px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <Link href={`/runs/${run.id}`} className="text-sm hover:text-aurora">
                  {run.name}
                </Link>
                {run.is_completed ? <span className="pill text-muted">Closed</span> : null}
                {run.source ? (
                  <span className="pill text-muted">
                    {run.source} #{run.source_id}
                  </span>
                ) : null}
                <p className="ml-auto text-xs text-muted">{formatTimestamp(run.created_on)}</p>
              </div>
              <div className="mt-2 flex flex-col gap-1">
                <StatusBar progress={run.progress} statuses={statuses} />
                <PassRate progress={run.progress} />
              </div>
            </li>
          ))}
        </ul>

        {runs !== null && runs.rows.length === 0 ? (
          <p className="py-8 text-sm text-muted">
            This project has no runs yet. Create one through the API, or import it.
          </p>
        ) : null}
      </div>

      <footer className="flex items-center gap-3 border-t border-line px-6 py-3">
        <button type="button" className="chip" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
          Previous
        </button>
        <button
          type="button"
          className="chip"
          disabled={lastOnPage >= total}
          onClick={() => goToPage(page + 1)}
        >
          Next
        </button>
        <label htmlFor="run-page-size" className="label ml-auto">
          Rows
        </label>
        <select
          id="run-page-size"
          className="field-sm"
          value={limit}
          onChange={(event) => {
            const params = new URLSearchParams(searchParams.toString());
            params.set("limit", event.target.value);
            params.set("page", "1");
            router.replace(`/runs?${params.toString()}`);
          }}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </footer>
    </div>
  );
}
