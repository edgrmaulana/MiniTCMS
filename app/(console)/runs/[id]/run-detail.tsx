"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  clampPage,
  clampPageSize,
  type AssignableUser,
  type ListResult,
  type RunProgress,
  type RunRow,
  type StatusRow,
  type TestRow,
  type UserRole,
} from "@/lib/format";
import { actionForKey } from "@/lib/keys";
import { toggleSelected } from "@/lib/selection";
import { fetchJson, postJson } from "../../../fetch-json";
import { PassRate, StatusBar } from "../status-bar";
import ResultPanel, { type PanelIntent } from "./result-panel";

type RunDetailRow = RunRow & { progress: RunProgress; resultCount: number | null };

const SEARCH_DEBOUNCE_MS = 300;

/*
  The execution screen, and the one place in this product where a keystroke is
  the hot path. Three rules shape it:

  - No animation and no spinner between a key and a visible status. A passed
    or retest keystroke writes straight through and the row changes at once;
    if the POST fails the row goes back to what it was and says why.
  - Failed and blocked open the panel with the comment focused instead,
    because lib/db.ts refuses those without one and finding that out after the
    keystroke looks like a lost result.
  - The map itself lives in lib/keys.ts, so which digit means what is tested
    without a browser.
*/
export default function RunDetail({ runId, role }: { runId: number; role: UserRole }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const statusFilter = searchParams.get("status") ?? "";
  const assignedTo = searchParams.get("assignedTo") ?? "";
  const search = searchParams.get("search") ?? "";
  const page = clampPage(searchParams.get("page") ?? 1);
  const limit = clampPageSize(searchParams.get("limit") ?? DEFAULT_PAGE_SIZE);

  const [run, setRun] = useState<RunDetailRow | null>(null);
  const [statuses, setStatuses] = useState<StatusRow[]>([]);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [testsFetch, setTestsFetch] = useState<{ query: string; result: ListResult<TestRow> } | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [intent, setIntent] = useState<PanelIntent | null>(null);
  const [searchText, setSearchText] = useState(search);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  const setParams = useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      if (!("page" in changes)) next.delete("page");
      router.replace(`/runs/${runId}?${next.toString()}`);
    },
    [router, runId, searchParams],
  );

  const loadRun = useCallback(async () => {
    const fresh = await fetchJson<RunDetailRow>(`/api/runs/${runId}`);
    setRun(fresh);
  }, [runId]);

  useEffect(() => {
    let current = true;
    fetchJson<RunDetailRow>(`/api/runs/${runId}`)
      .then((fresh) => {
        if (current) setRun(fresh);
      })
      .catch((reason: Error) => {
        if (current) setError(reason.message);
      });
    return () => {
      current = false;
    };
  }, [runId]);

  useEffect(() => {
    let current = true;
    Promise.all([
      fetchJson<{ rows: StatusRow[] }>("/api/statuses"),
      fetchJson<ListResult<AssignableUser>>("/api/users?limit=100"),
    ])
      .then(([statusResult, userResult]) => {
        if (!current) return;
        setStatuses(statusResult.rows);
        setUsers(userResult.rows);
      })
      .catch((reason: Error) => {
        if (current) setError(reason.message);
      });
    return () => {
      current = false;
    };
  }, []);

  const testsQuery = useMemo(() => {
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (statusFilter) query.set("status", statusFilter);
    if (assignedTo) query.set("assignedTo", assignedTo);
    if (search) query.set("search", search);
    return query.toString();
  }, [statusFilter, assignedTo, search, page, limit]);

  const loadTests = useCallback(async () => {
    const result = await fetchJson<ListResult<TestRow>>(`/api/runs/${runId}/tests?${testsQuery}`);
    setTestsFetch({ query: testsQuery, result });
  }, [runId, testsQuery]);

  useEffect(() => {
    let current = true;
    fetchJson<ListResult<TestRow>>(`/api/runs/${runId}/tests?${testsQuery}`)
      .then((result) => {
        if (!current) return;
        setError(null);
        setTestsFetch({ query: testsQuery, result });
        setCursor(0);
      })
      .catch((reason: Error) => {
        if (current) setError(reason.message);
      });
    return () => {
      current = false;
    };
  }, [runId, testsQuery]);

  useEffect(() => {
    if (searchText === search) return;
    const timer = setTimeout(() => setParams({ search: searchText }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText, search, setParams]);

  // Rows and count only count while they answer the current query; a reply to
  // the previous filter never paints.
  const tests = useMemo(
    () => (testsFetch?.query === testsQuery ? testsFetch.result.rows : []),
    [testsFetch, testsQuery],
  );
  const total = testsFetch?.query === testsQuery ? testsFetch.result.total : 0;
  const statusById = useMemo(() => new Map(statuses.map((status) => [status.id, status])), [statuses]);
  const userById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const runClosed = run?.is_completed === 1;

  const patchRows = useCallback((testIds: readonly number[], statusId: number) => {
    setTestsFetch((previous) => {
      if (!previous) return previous;
      const ids = new Set(testIds);
      return {
        ...previous,
        result: {
          ...previous.result,
          rows: previous.result.rows.map((test) =>
            ids.has(test.id) ? { ...test, status_id: statusId } : test,
          ),
        },
      };
    });
  }, []);

  /*
    Optimistic, then reconciled. The row shows the new status on the keystroke;
    a rejected write puts the old one back, because a row that keeps a status
    the server never stored is the one failure mode worth more than a spinner.
  */
  const recordStatus = useCallback(
    async (testIds: readonly number[], statusId: number) => {
      if (testIds.length === 0) return;
      const before = new Map(tests.map((test) => [test.id, test.status_id]));
      patchRows(testIds, statusId);
      setError(null);
      try {
        await postJson(`/api/runs/${runId}/tests/status`, { testIds: [...testIds], statusId });
        await loadRun();
      } catch (reason) {
        for (const testId of testIds) {
          const previous = before.get(testId);
          if (previous !== undefined) patchRows([testId], previous);
        }
        setError((reason as Error).message);
      }
    },
    [tests, patchRows, runId, loadRun],
  );

  const advanceToNextUntested = useCallback(() => {
    const next = tests.findIndex(
      (test, index) => index > cursor && statusById.get(test.status_id)?.is_untested === 1,
    );
    if (next === -1) {
      setNotice("No untested test left on this page.");
      return;
    }
    setCursor(next);
  }, [tests, cursor, statusById]);

  // j/k past the fold has to bring the row with it, or the cursor walks off
  // screen and the next keystroke lands somewhere the eye cannot see.
  useEffect(() => {
    rowRefs.current[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // One listener for the whole screen; lib/keys.ts decides what a key means.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;
      const cursorTest = tests[cursor];
      const action = actionForKey(event.key, {
        statuses,
        selectionSize: selected.size,
        runClosed: runClosed === true,
      });
      if (!action) return;
      event.preventDefault();
      setNotice(null);

      switch (action.kind) {
        case "move":
          setCursor((current) => Math.min(Math.max(current + action.delta, 0), Math.max(tests.length - 1, 0)));
          return;
        case "toggleSelect":
          if (cursorTest) setSelected((current) => toggleSelected(current, cursorTest.id));
          return;
        case "clearSelection":
          setSelected(new Set());
          setIntent(null);
          return;
        case "focusFilter":
          searchRef.current?.focus();
          return;
        case "openPanel":
          if (cursorTest) {
            setIntent({
              test: cursorTest,
              testIds: selected.size > 0 ? [...selected] : [cursorTest.id],
              statusId: null,
              focusComment: false,
            });
          }
          return;
        case "recordAndAdvance":
          advanceToNextUntested();
          return;
        case "refused":
          setNotice(action.reason);
          return;
        case "record": {
          const targets = action.scope === "selection" ? [...selected] : cursorTest ? [cursorTest.id] : [];
          if (targets.length === 0) return;
          if (action.wantsComment) {
            /*
              Needs a comment, so it cannot be written blind - the panel opens
              with that status chosen and the comment focused. It carries the
              whole selection, not just the cursor row: a status key applies to
              the selection whether or not it needs a comment, and recording one
              row out of ten while clearing the selection loses nine edits
              silently.
            */
            const test =
              tests.find((candidate) => candidate.id === targets[0]) ?? cursorTest ?? null;
            if (test) {
              setIntent({ test, testIds: targets, statusId: action.statusId, focusComment: true });
            }
            return;
          }
          void recordStatus(targets, action.statusId);
          return;
        }
        default:
          return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tests, cursor, statuses, selected, runClosed, recordStatus, advanceToNextUntested]);

  async function toggleClosed() {
    if (!run) return;
    setError(null);
    try {
      await fetchJson(`/api/runs/${runId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isCompleted: run.is_completed === 0 }),
      });
      await loadRun();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function deleteRun() {
    if (!run) return;
    setError(null);
    let resultCount: number;
    try {
      // Counted here rather than on every poll: this route only counts results
      // when asked, because the run screen re-reads it after every keystroke.
      const counted = await fetchJson<RunDetailRow>(`/api/runs/${runId}?resultCount=true`);
      resultCount = counted.resultCount ?? 0;
    } catch (reason) {
      setError((reason as Error).message);
      return;
    }
    const confirmed = window.confirm(
      `Delete "${run.name}"? This destroys ${run.progress.total} tests and ${resultCount} recorded results. It cannot be undone.`,
    );
    if (!confirmed) return;
    try {
      const outcome = await fetchJson<{ resultsDeleted: number }>(`/api/runs/${runId}`, {
        method: "DELETE",
      });
      router.replace(`/runs?projectId=${run.project_id}&deleted=${outcome.resultsDeleted}`);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  if (!run) {
    return (
      <section className="flex flex-col gap-3 px-8 py-16">
        {error ? (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        ) : (
          <p className="text-sm text-muted">Loading run</p>
        )}
        <Link href="/runs" className="chip w-32 text-center">
          Back to runs
        </Link>
      </section>
    );
  }

  const lastOnPage = Math.min(page * limit, total);

  return (
    <div className="flex h-dvh overflow-hidden">
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex flex-col gap-3 border-b border-line px-6 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <Link href={`/runs?projectId=${run.project_id}`} className="chip">
              Back
            </Link>
            <h1 className="display text-xl">{run.name}</h1>
            {runClosed ? <span className="pill text-muted">Closed</span> : null}
            <div className="ml-auto flex gap-2">
              <button type="button" className="chip" onClick={toggleClosed}>
                {runClosed ? "Reopen run" : "Close run"}
              </button>
              {role === "admin" ? (
                <button type="button" className="chip text-alert" onClick={deleteRun}>
                  Delete run
                </button>
              ) : null}
            </div>
          </div>
          <StatusBar progress={run.progress} statuses={statuses} />
          <PassRate progress={run.progress} />
        </header>

        <div className="flex flex-wrap items-end gap-3 border-b border-line px-6 py-3">
          <div className="flex min-w-56 flex-col gap-1">
            <label htmlFor="test-search" className="label">
              Filter titles
            </label>
            <input
              id="test-search"
              ref={searchRef}
              type="search"
              className="field-sm"
              value={searchText}
              placeholder="press / to focus"
              spellCheck={false}
              onChange={(event) => setSearchText(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="label">Status</span>
            <div className="flex flex-wrap gap-1">
              {statuses.map((status) => {
                const active = statusFilter.split(",").includes(String(status.id));
                return (
                  <button
                    key={status.id}
                    type="button"
                    className="chip"
                    aria-pressed={active}
                    style={active ? { borderColor: status.color ?? undefined, color: status.color ?? undefined } : undefined}
                    onClick={() => setParams({ status: toggleCsv(statusFilter, status.id) })}
                  >
                    {status.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="assignee-filter" className="label">
              Assignee
            </label>
            <select
              id="assignee-filter"
              className="field-sm"
              value={assignedTo}
              onChange={(event) => setParams({ assignedTo: event.target.value })}
            >
              <option value="">Anyone</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name ?? user.email}
                </option>
              ))}
            </select>
          </div>

          <p className="ml-auto text-xs text-muted">
            {/* A ?page= past the end is reachable from any pasted link once rows
                are deleted or a filter narrows; "101-100 of 100" is not a range. */}
            {tests.length === 0
              ? total === 0
                ? "No tests"
                : `Nothing on this page of ${total}`
              : `${(page - 1) * limit + 1}-${lastOnPage} of ${total}`}
            {selected.size > 0 ? ` - ${selected.size} selected` : ""}
          </p>
        </div>

        {notice ? <p className="border-b border-line px-6 py-2 text-xs text-muted">{notice}</p> : null}
        {error ? (
          <p role="alert" className="border-b border-alert px-6 py-2 text-sm text-alert">
            {error}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col" className="w-8" />
                <th scope="col" className="w-16">
                  ID
                </th>
                <th scope="col">Title</th>
                <th scope="col" className="w-28">
                  Status
                </th>
                <th scope="col" className="w-40">
                  Assignee
                </th>
              </tr>
            </thead>
            <tbody>
              {tests.map((test, index) => {
                const status = statusById.get(test.status_id);
                return (
                  <tr
                    key={test.id}
                    ref={(node) => {
                      rowRefs.current[index] = node;
                    }}
                    data-selected={selected.has(test.id)}
                    data-cursor={index === cursor}
                    onClick={() => setCursor(index)}
                  >
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select test ${test.id}`}
                        checked={selected.has(test.id)}
                        onChange={() => setSelected((current) => toggleSelected(current, test.id))}
                      />
                    </td>
                    <td className="text-muted">{test.id}</td>
                    <td className="truncate">
                      <button
                        type="button"
                        className="text-left hover:text-aurora"
                        onClick={() => {
                          setCursor(index);
                          setIntent({
                            test,
                            testIds: [test.id],
                            statusId: null,
                            focusComment: false,
                          });
                        }}
                      >
                        {test.title_snapshot}
                      </button>
                    </td>
                    <td>
                      <span className="pill" style={{ color: status?.color ?? undefined }}>
                        {status?.label ?? `#${test.status_id}`}
                      </span>
                    </td>
                    <td className="truncate text-muted">
                      {test.assigned_to === null
                        ? "-"
                        : userById.get(test.assigned_to)?.name ??
                          userById.get(test.assigned_to)?.email ??
                          `#${test.assigned_to}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {testsFetch !== null && tests.length === 0 ? (
            <p className="px-6 py-8 text-sm text-muted">No test in this run matches these filters.</p>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center gap-3 border-t border-line px-6 py-3">
          <button type="button" className="chip" disabled={page <= 1} onClick={() => setParams({ page: String(page - 1) })}>
            Previous
          </button>
          <button
            type="button"
            className="chip"
            disabled={lastOnPage >= total}
            onClick={() => setParams({ page: String(page + 1) })}
          >
            Next
          </button>
          <p className="text-xs text-muted">
            j/k move - 1 pass, 2 block, 4 retest, 5 fail - space opens, enter jumps to the next
            untested, x selects, esc clears, / filters
          </p>
          <select
            className="field-sm ml-auto"
            aria-label="Rows per page"
            value={limit}
            onChange={(event) => setParams({ limit: event.target.value, page: "1" })}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </footer>
      </section>

      {intent ? (
        /*
          Keyed on what the panel is for. Without the key React keeps the
          mounted form and its useState values, so pressing 5 on the next row
          would record the previous row's status and comment.
        */
        <ResultPanel
          key={`${intent.testIds.join(",")}-${intent.statusId ?? "any"}`}
          intent={intent}
          runId={runId}
          statuses={statuses}
          users={users}
          runClosed={runClosed === true}
          onClose={() => setIntent(null)}
          onRecorded={(statusId) => {
            patchRows(intent.testIds, statusId);
            setIntent(null);
            setSelected(new Set());
            advanceToNextUntested();
            void loadRun();
            void loadTests();
          }}
        />
      ) : null}
    </div>
  );
}

/*
  A keystroke that belongs to the focused element is left to it. Without the
  fields, "5" typed into a comment records a failed result behind the panel;
  without the buttons and links, enter and space on a focused "Close run" are
  swallowed by the map and the run screen cannot be driven by tab at all.
*/
const SELF_HANDLING = ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "SUMMARY", "OPTION"];

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.getAttribute("role") === "button") return true;
  return SELF_HANDLING.includes(target.tagName);
}

function toggleCsv(current: string, id: number): string {
  const ids = current.split(",").filter(Boolean);
  const without = ids.filter((entry) => entry !== String(id));
  return without.length === ids.length ? [...ids, String(id)].join(",") : without.join(",");
}
