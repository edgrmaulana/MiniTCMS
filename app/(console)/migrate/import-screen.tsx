"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  DATE_ORDERS,
  formatTimestamp,
  type ImportRunRow,
  type ListResult,
  type ProjectRow,
} from "@/lib/format";
import type { ImportReport } from "@/lib/migrate/report";
import { HttpError, fetchJson } from "../../fetch-json";
import ImportReportView from "./import-report";

type ImportRunDetail = Omit<ImportRunRow, "report" | "cursor"> & {
  report: ImportReport | null;
  stepsCompleted: number;
};

type CsvOutcome = { importRunId: number; report: ImportReport; dryRun: boolean };

const RUNNING_STATES = ["pending", "running"];

const POLL_MS = 3000;

/*
  Two entry points, and they are deliberately different shapes.

  The CSV path is a request: a 243-case export imports in 69ms, so the upload
  answers with its report and there is nothing to poll. The API path is minutes
  to hours against a live instance, which is a CLI job (`npm run migrate`) and
  not a request a browser holds open - phase 4 decided that and there is no
  route to start one. What this screen does for the API path is what a screen
  can honestly do: tell you the command, and show you the progress and the
  report of the import the CLI is writing, polled from import_runs.
*/
export default function ImportScreen() {
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [imports, setImports] = useState<ImportRunRow[] | null>(null);
  const [opened, setOpened] = useState<ImportRunDetail | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [projectId, setProjectId] = useState(searchParams.get("projectId") ?? "");
  const [timeZone, setTimeZone] = useState("");
  const [dateOrder, setDateOrder] = useState("");
  const [users, setUsers] = useState("");
  const [allowMixedSources, setAllowMixedSources] = useState(false);
  const [outcome, setOutcome] = useState<CsvOutcome | null>(null);

  /*
    Any change to what would be sent throws the dry run away. "Import for real"
    is only ever enabled for settings a dry run actually reported on - otherwise
    changing the project after a preview writes a configuration nobody checked,
    which is the whole thing the second button exists to prevent.
  */
  function setSetting<Value>(set: (value: Value) => void): (value: Value) => void {
    return (value) => {
      set(value);
      setOutcome(null);
    };
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  const zones = useMemo(() => zoneNames(), []);

  useEffect(() => {
    let current = true;
    fetchJson<ListResult<ProjectRow>>("/api/projects?limit=100")
      .then((result) => {
        if (current) setProjects(result.rows);
      })
      .catch((reason: Error) => {
        if (current) setError(reason.message);
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    fetchJson<ListResult<ImportRunRow>>("/api/migrate?limit=25")
      .then((result) => {
        if (current) setImports(result.rows);
      })
      .catch((reason: Error) => {
        if (!current) return;
        // Listing imports is admin or lead only. That is the answer, not a
        // failure: the rest of the screen would be useless anyway. Read off the
        // status rather than the wording, which a reworded message would break.
        if (reason instanceof HttpError && reason.status === 403) setForbidden(true);
        else setError(reason.message);
      });
    return () => {
      current = false;
    };
  }, [reloads]);

  // A CLI import writes its progress into import_runs as it goes, so the only
  // honest way to follow it from here is to ask again while one is live.
  const anyRunning = (imports ?? []).some((entry) => RUNNING_STATES.includes(entry.state));
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setReloads((count) => count + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [anyRunning]);

  async function upload(dryRun: boolean) {
    if (!file) {
      setError("Choose a CSV export first");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("projectId", projectId);
      form.set("timeZone", timeZone);
      form.set("dateOrder", dateOrder);
      if (users.trim()) form.set("users", users.trim());
      if (allowMixedSources) form.set("allowMixedSources", "true");
      form.set("dryRun", dryRun ? "true" : "false");

      const result = await fetchJson<{ importRunId: number; report: ImportReport }>(
        "/api/migrate/csv",
        { method: "POST", body: form },
      );
      setOutcome({ ...result, dryRun });
      setReloads((count) => count + 1);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function open(id: number) {
    setError(null);
    try {
      setOpened(await fetchJson<ImportRunDetail>(`/api/migrate/${id}`));
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  if (forbidden) {
    return (
      <section className="mx-auto flex max-w-xl flex-col gap-3 px-8 py-16">
        <p className="label">Import</p>
        <p className="display text-2xl">This needs the admin or lead role.</p>
        <p className="text-sm text-muted">
          An import writes across every project, so it is not open to every session.
        </p>
      </section>
    );
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-line px-6 py-4">
        <p className="label">Import</p>
        <h1 className="display text-xl">From TestRail</h1>
      </header>

      {error ? (
        <p role="alert" className="border-b border-alert px-6 py-2 text-sm text-alert">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="flex max-w-5xl flex-col gap-8">
          <section className="flex flex-col gap-3">
            <p className="label">Case CSV export</p>
            <p className="text-sm text-muted">
              Three things the file cannot tell us, so none of them has a default: which
              project the cases belong to, which timezone its timestamps were written in,
              and whether &quot;10/1/2026&quot; is October 1st or January 10th.
            </p>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <label htmlFor="csv" className="label">
                  File
                </label>
                <input
                  id="csv"
                  type="file"
                  accept=".csv,text/csv"
                  className="field-sm"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setOutcome(null);
                  }}
                />
              </div>

              <div className="flex flex-col gap-2">
                <label htmlFor="import-project" className="label">
                  Project
                </label>
                <select
                  id="import-project"
                  className="field-sm"
                  value={projectId}
                  onChange={(event) => setSetting(setProjectId)(event.target.value)}
                >
                  <option value="">Select a project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-2">
                <label htmlFor="timezone" className="label">
                  Timezone of the export
                </label>
                <input
                  id="timezone"
                  className="field-sm"
                  list="zones"
                  value={timeZone}
                  placeholder="Asia/Jakarta"
                  spellCheck={false}
                  onChange={(event) => setSetting(setTimeZone)(event.target.value)}
                />
                <datalist id="zones">
                  {zones.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
              </div>

              <div className="flex flex-col gap-2">
                <label htmlFor="date-order" className="label">
                  Date order
                </label>
                <select
                  id="date-order"
                  className="field-sm"
                  value={dateOrder}
                  onChange={(event) => setSetting(setDateOrder)(event.target.value)}
                >
                  <option value="">Select an order</option>
                  {DATE_ORDERS.map((order) => (
                    <option key={order} value={order}>
                      {order === "mdy" ? "mdy - month first (10/1 is October 1st)" : "dmy - day first (10/1 is January 10th)"}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-2 md:col-span-2">
                <label htmlFor="user-map" className="label">
                  Name to email map (optional)
                </label>
                <input
                  id="user-map"
                  className="field-sm"
                  value={users}
                  placeholder="Ada Lovelace=ada@example.com, Grace Hopper=grace@example.com"
                  spellCheck={false}
                  onChange={(event) => setSetting(setUsers)(event.target.value)}
                />
                <p className="text-xs text-muted">
                  A CSV carries display names, not emails. A name this map does not
                  cover, or one that matches two accounts, is left unassigned and
                  reported - never guessed.
                </p>
              </div>

              <label className="flex items-center gap-2 text-xs text-muted md:col-span-2">
                <input
                  type="checkbox"
                  checked={allowMixedSources}
                  onChange={(event) => setSetting(setAllowMixedSources)(event.target.checked)}
                />
                Allow this export to touch rows that came from a different source
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="chip" disabled={busy} onClick={() => upload(true)}>
                {busy ? "Working" : "Dry run"}
              </button>
              <button
                type="button"
                className="signin px-4 py-2"
                disabled={busy || outcome === null || !outcome.dryRun}
                onClick={() => upload(false)}
              >
                Import for real
              </button>
              <p className="text-xs text-muted">
                A dry run reads the whole file and reports what it would do, inside a
                transaction that is rolled back. Nothing is written until the second
                button.
              </p>
            </div>
          </section>

          {outcome ? (
            <section className="flex flex-col gap-3">
              <p className="label">
                {outcome.dryRun ? "Dry run report" : "Import report"} - import run{" "}
                {outcome.importRunId}
              </p>
              {outcome.dryRun ? (
                <p className="text-sm text-aurora">
                  Nothing was written. These are the counts the real import would produce.
                </p>
              ) : null}
              <ImportReportView report={outcome.report} />
            </section>
          ) : null}

          <section className="flex flex-col gap-3">
            <p className="label">Whole TestRail instance</p>
            <p className="text-sm text-muted">
              An instance import runs for minutes to hours and resumes where it died, so
              it is a CLI job rather than a request a browser holds open. It reads
              TESTRAIL_HOST, TESTRAIL_USER and TESTRAIL_API_KEY from the environment -
              credentials never travel through this screen.
            </p>
            <pre className="sheet overflow-x-auto px-3 py-2 text-xs text-muted">
              npm run migrate -- --dry-run{"\n"}
              npm run migrate{"\n"}
              npm run migrate -- --resume 3
            </pre>
            <p className="text-xs text-muted">
              Progress appears below while it runs, and its report stays readable
              afterwards.
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <p className="label">Imports</p>
              {anyRunning ? <p className="text-xs text-aurora">Polling every 3s</p> : null}
            </div>
            {imports === null ? <p className="text-sm text-muted">Loading</p> : null}
            {imports?.length === 0 ? (
              <p className="text-sm text-muted">Nothing has been imported into this instance yet.</p>
            ) : null}
            <ul className="flex flex-col gap-1">
              {imports?.map((entry) => (
                <li key={entry.id} className="sheet flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  <span className="pill text-muted">{entry.id}</span>
                  <span className={entry.state === "failed" ? "text-alert" : undefined}>
                    {entry.state}
                  </span>
                  <span className="text-xs text-muted">{entry.source}</span>
                  <span className="text-xs text-muted">
                    started {formatTimestamp(entry.started_on)}
                    {entry.finished_on ? `, finished ${formatTimestamp(entry.finished_on)}` : ""}
                  </span>
                  <button type="button" className="chip ml-auto" onClick={() => open(entry.id)}>
                    Report
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {opened ? (
            <section className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <p className="label">
                  Import run {opened.id} - {opened.state}, {opened.stepsCompleted} stages done
                </p>
                <button type="button" className="chip ml-auto" onClick={() => setOpened(null)}>
                  Close
                </button>
              </div>
              {opened.report ? (
                <ImportReportView report={opened.report} />
              ) : (
                <p className="text-sm text-muted">
                  This import has written no report yet. A running import writes it at the
                  end; a crashed one keeps the counts it had reached.
                </p>
              )}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Every IANA zone the browser knows, for the datalist. Older engines without
// supportedValuesOf get a plain text box, which the server validates anyway.
function zoneNames(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}
