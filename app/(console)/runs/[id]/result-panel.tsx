"use client";

import { useEffect, useRef, useState } from "react";
import {
  formatTimestamp,
  isAssignableStatus,
  needsComment,
  type AssignableUser,
  type ResultRow,
  type StatusRow,
  type TestRow,
} from "@/lib/format";
import { fetchJson, postJson } from "../../../fetch-json";

/*
  `testIds` is who the next record is for: the selection when a status key fired
  with one active, otherwise just the cursor row. `test` is the row the panel is
  titled with and whose history it shows.
*/
export type PanelIntent = {
  test: TestRow;
  testIds: readonly number[];
  statusId: number | null;
  focusComment: boolean;
};

/*
  The result form, and under it the only change log this product has: that
  test's results, newest first. A result is never edited - a correction is a
  new row - so there is nothing on this panel that updates history.
*/
export default function ResultPanel({
  intent,
  runId,
  statuses,
  users,
  runClosed,
  onClose,
  onRecorded,
}: {
  intent: PanelIntent;
  runId: number;
  statuses: readonly StatusRow[];
  users: readonly AssignableUser[];
  runClosed: boolean;
  onClose: () => void;
  onRecorded: (statusId: number) => void;
}) {
  const assignable = statuses.filter(isAssignableStatus);
  const [statusId, setStatusId] = useState<number>(intent.statusId ?? assignable[0]?.id ?? 0);
  const [comment, setComment] = useState("");
  const [elapsed, setElapsed] = useState("");
  const [defects, setDefects] = useState("");
  const [version, setVersion] = useState("");
  const [assignedTo, setAssignedTo] = useState<string>(
    intent.test.assigned_to === null ? "" : String(intent.test.assigned_to),
  );
  const [history, setHistory] = useState<ResultRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (intent.focusComment) commentRef.current?.focus();
  }, [intent]);

  useEffect(() => {
    let current = true;
    fetchJson<{ rows: ResultRow[] }>(`/api/tests/${intent.test.id}/results?limit=25`)
      .then((result) => {
        if (current) setHistory(result.rows);
      })
      .catch((reason: Error) => {
        if (current) setError(reason.message);
      });
    return () => {
      current = false;
    };
  }, [intent.test.id]);

  const bulk = intent.testIds.length > 1;

  /*
    One result or the whole selection, through the two routes that already
    exist: /api/results carries the per-test detail, and the run's status route
    writes one result per id in one transaction. The second cannot carry an
    elapsed time or a defect reference, because those are facts about one test,
    so the form hides them rather than collecting values it would drop.
  */
  async function record() {
    setBusy(true);
    setError(null);
    try {
      if (bulk) {
        await postJson(`/api/runs/${runId}/tests/status`, {
          testIds: [...intent.testIds],
          statusId,
          comment: comment.trim() === "" ? null : comment,
        });
      } else {
        await postJson("/api/results", {
          results: [
            {
              testId: intent.test.id,
              statusId,
              comment: comment.trim() === "" ? null : comment,
              elapsed: elapsed.trim() === "" ? null : elapsed,
              defects: defects.trim() === "" ? null : defects,
              version: version.trim() === "" ? null : version,
              assignedTo: assignedTo === "" ? null : Number(assignedTo),
            },
          ],
        });
      }
      onRecorded(statusId);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const statusLabels = new Map(statuses.map((status) => [status.id, status]));

  return (
    <aside className="flex w-[26rem] shrink-0 flex-col gap-3 overflow-y-auto border-l border-line bg-[rgba(8,12,22,0.95)] px-4 py-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <p className="label">
            {bulk ? `${intent.testIds.length} tests selected` : `Test ${intent.test.id}`}
          </p>
          <p className="truncate text-sm">{intent.test.title_snapshot}</p>
        </div>
        <button type="button" className="chip ml-auto" onClick={onClose}>
          Close
        </button>
      </div>

      {runClosed ? (
        <p className="text-xs text-muted">This run is closed. Reopen it to record a result.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="result-status" className="label">
              Status
            </label>
            <select
              id="result-status"
              className="field-sm"
              value={statusId}
              onChange={(event) => setStatusId(Number(event.target.value))}
            >
              {assignable.map((status) => (
                <option key={status.id} value={status.id}>
                  {status.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="result-comment" className="label">
              Comment{needsComment(statusId) ? " (required)" : ""}
            </label>
            <textarea
              id="result-comment"
              ref={commentRef}
              className="field-sm"
              rows={4}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </div>

          {bulk ? (
            <p className="text-xs text-muted">
              This records the status and the comment against all{" "}
              {intent.testIds.length} selected tests. Elapsed time, defects, version and
              assignee are per-test, so they are not offered here.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Line id="result-elapsed" label="Elapsed" value={elapsed} placeholder="1m 45s" onChange={setElapsed} />
              <Line id="result-version" label="Version" value={version} placeholder="2026.10.1" onChange={setVersion} />
              <Line id="result-defects" label="Defects" value={defects} placeholder="BUG-1024" onChange={setDefects} />
              <div className="flex flex-col gap-1">
                <label htmlFor="result-assignee" className="label">
                  Assignee
                </label>
                <select
                  id="result-assignee"
                  className="field-sm"
                  value={assignedTo}
                  onChange={(event) => setAssignedTo(event.target.value)}
                >
                  <option value="">Unassigned</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name ?? user.email}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {error ? (
            <p role="alert" className="text-sm text-alert">
              {error}
            </p>
          ) : null}

          <button type="button" className="signin" disabled={busy} onClick={record}>
            {busy ? "Recording" : bulk ? `Record for ${intent.testIds.length} tests` : "Record result"}
          </button>
        </div>
      )}

      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <p className="label">History</p>
        {history === null ? <p className="text-xs text-muted">Loading</p> : null}
        {history?.length === 0 ? (
          <p className="text-xs text-muted">No result has been recorded against this test.</p>
        ) : null}
        {history?.map((result) => (
          <article key={result.id} className="sheet px-3 py-2">
            <p className="flex items-center gap-2 text-xs">
              <span style={{ color: statusLabels.get(result.status_id)?.color ?? undefined }}>
                {statusLabels.get(result.status_id)?.label ?? `#${result.status_id}`}
              </span>
              <span className="text-muted">{formatTimestamp(result.created_on)}</span>
              {result.elapsed ? <span className="text-muted">{result.elapsed}</span> : null}
            </p>
            {result.comment ? <p className="mt-1 whitespace-pre-wrap text-sm">{result.comment}</p> : null}
            {result.defects ? <p className="mt-1 text-xs text-muted">Defects: {result.defects}</p> : null}
            {result.version ? <p className="text-xs text-muted">Version: {result.version}</p> : null}
          </article>
        ))}
      </section>
    </aside>
  );
}

function Line({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        className="field-sm"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
