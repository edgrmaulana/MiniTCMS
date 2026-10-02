"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CASE_PRIORITY,
  CASE_PRIORITY_LABELS,
  CASE_TYPE,
  CASE_TYPE_LABELS,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  clampPage,
  clampPageSize,
  labelFor,
  roleAtLeast,
  type CaseRow,
  type ListResult,
  type SectionTreeRow,
  type SuiteRow,
  type UserRole,
} from "@/lib/format";
import { selectRange, toggleAll, toggleSelected } from "@/lib/selection";
import { fetchJson, postJson } from "../../fetch-json";
import SectionTree from "./section-tree";

const SEARCH_DEBOUNCE_MS = 300;

/*
  Every bit of screen state that survives a reload is in the query string: the
  suite, the section, the filters, the page. The component keeps only what is
  genuinely transient - the selection, the un-debounced search text, the error
  from the last request.

  Rows come a page at a time from /api/cases, which pages in SQL. Nothing here
  filters or sorts a fetched array; a suite holding 50k cases must cost the
  same as one holding 50.
*/
export default function CasesScreen({ role }: { role: UserRole }) {
  // Editing a case is lead work. A tester still selects rows - selection is how
  // you read a long list - but is not handed controls the API would refuse.
  const mayEdit = roleAtLeast(role, "lead");
  const router = useRouter();
  const searchParams = useSearchParams();

  const projectId = searchParams.get("projectId");
  const suiteId = searchParams.get("suiteId");
  const sectionId = searchParams.get("sectionId");
  const typeId = searchParams.get("typeId") ?? "";
  const priorityId = searchParams.get("priorityId") ?? "";
  const search = searchParams.get("search") ?? "";
  const page = clampPage(searchParams.get("page") ?? 1);
  const limit = clampPageSize(searchParams.get("limit") ?? DEFAULT_PAGE_SIZE);

  /*
    Each fetched payload is stored next to the id or query it answers, and the
    render compares the two. A suite list belonging to the project just left,
    or a page of cases matching the filter before last, is never shown while
    the new request is in flight.
  */
  const [suitesFetch, setSuitesFetch] = useState<{ projectId: string; rows: SuiteRow[] } | null>(null);
  const [sectionsFetch, setSectionsFetch] = useState<{ suiteId: string; rows: SectionTreeRow[] } | null>(null);
  const [casesFetch, setCasesFetch] = useState<{ query: string; result: ListResult<CaseRow> } | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [anchorId, setAnchorId] = useState<number | null>(null);
  const [searchText, setSearchText] = useState(search);
  const [reloads, setReloads] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setParams = useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      // A filter change drops the page: page 7 of a narrower result is usually
      // an empty table, which reads as "no cases" rather than "wrong page".
      if (!("page" in changes)) next.delete("page");
      router.replace(`/cases?${next.toString()}`);
    },
    [router, searchParams],
  );

  /*
    `current` drops a reply that arrived after its question was replaced. Two
    requests in flight finish in whatever order the network chooses, and
    without this the loser can land last and leave the screen showing the
    answer to a filter nobody is looking at any more.
  */
  useEffect(() => {
    if (!projectId) return;
    let current = true;
    // ponytail: one page of suites. A project with more than 100 needs a
    // search here, which is the same fix the project switcher will want.
    fetchJson<ListResult<SuiteRow>>(`/api/suites?projectId=${projectId}&limit=100`)
      .then((result) => {
        if (current) setSuitesFetch({ projectId, rows: result.rows });
      })
      .catch((reason: Error) => {
        if (current) setError(reason.message);
      });
    return () => {
      current = false;
    };
  }, [projectId]);

  const suites = useMemo(
    () => (suitesFetch?.projectId === projectId ? suitesFetch.rows : []),
    [suitesFetch, projectId],
  );

  // A project with one suite - TestRail's single-suite mode, so most of them -
  // should not ask which suite before showing anything.
  useEffect(() => {
    if (suiteId || suites.length === 0) return;
    setParams({ suiteId: String(suites[0].id) });
  }, [suiteId, suites, setParams]);

  useEffect(() => {
    if (!suiteId) return;
    let current = true;
    fetchJson<{ rows: SectionTreeRow[] }>(`/api/suites/${suiteId}/sections`)
      .then((result) => {
        if (current) setSectionsFetch({ suiteId, rows: result.rows });
      })
      .catch((reason: Error) => {
        if (current) setError(reason.message);
      });
    return () => {
      current = false;
    };
  }, [suiteId]);

  const sections = useMemo(
    () => (sectionsFetch?.suiteId === suiteId ? sectionsFetch.rows : []),
    [sectionsFetch, suiteId],
  );

  const casesQuery = useMemo(() => {
    if (!suiteId) return null;
    const query = new URLSearchParams({ suiteId, page: String(page), limit: String(limit) });
    if (sectionId) query.set("sectionId", sectionId);
    if (typeId) query.set("typeId", typeId);
    if (priorityId) query.set("priorityId", priorityId);
    if (search) query.set("search", search);
    return query.toString();
  }, [suiteId, sectionId, typeId, priorityId, search, page, limit]);

  useEffect(() => {
    if (casesQuery === null) return;
    let current = true;
    fetchJson<ListResult<CaseRow>>(`/api/cases?${casesQuery}`)
      .then((result) => {
        if (!current) return;
        // Clears the last failure: leaving it up next to rows that did load
        // reads as "this list is wrong" when the list is fine.
        setError(null);
        setCasesFetch({ query: casesQuery, result });
      })
      .catch((reason: Error) => {
        if (current) setError(reason.message);
      });
    return () => {
      current = false;
    };
    // `reloads` is the refresh after a bulk write: the query is unchanged, so
    // nothing else in here would notice that the rows moved.
  }, [casesQuery, reloads]);

  const cases = casesFetch?.query === casesQuery ? casesFetch.result : null;

  useEffect(() => {
    if (searchText === search) return;
    const timer = setTimeout(() => setParams({ search: searchText }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText, search, setParams]);

  const rowIds = useMemo(() => cases?.rows.map((caseRow) => caseRow.id) ?? [], [cases]);
  const sectionNames = useMemo(
    () => new Map(sections.map((section) => [section.id, section.name])),
    [sections],
  );

  function clickRow(event: MouseEvent<HTMLInputElement>, caseId: number) {
    if (event.shiftKey) {
      setSelected(selectRange(selected, rowIds, anchorId, caseId));
      return;
    }
    setSelected(toggleSelected(selected, caseId));
    setAnchorId(caseId);
  }

  async function applyToSelection(patch: Record<string, number>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/cases/bulk", { caseIds: [...selected], ...patch });
      setSelected(new Set());
      setAnchorId(null);
      setReloads((count) => count + 1);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!projectId) {
    return <Empty>Choose a project in the rail to see its cases.</Empty>;
  }
  /*
    An empty `suites` means three different things - still loading, genuinely
    empty, or the request failed - and only the second one is "this project has
    no suites". Told apart by what came back, so a failed fetch shows its
    message instead of a confident wrong sentence.
  */
  if (error && suitesFetch?.projectId !== projectId) {
    return (
      <Empty>
        <span role="alert" className="text-alert">
          {error}
        </span>
      </Empty>
    );
  }
  if (suitesFetch?.projectId !== projectId) {
    return <Empty>Loading suites</Empty>;
  }
  if (suites.length === 0) {
    return <Empty>This project has no suites yet. Import one, or create it through the API.</Empty>;
  }

  const total = cases?.total ?? 0;
  const firstOnPage = (page - 1) * limit + 1;
  const lastOnPage = Math.min(page * limit, total);

  return (
    <div className="grid h-dvh grid-cols-[17rem_minmax(0,1fr)] overflow-hidden">
      <aside className="flex flex-col gap-3 overflow-hidden border-r border-line p-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="suite" className="label">
            Suite
          </label>
          <select
            id="suite"
            className="field-sm"
            value={suiteId ?? ""}
            onChange={(event) => {
              setSelected(new Set());
              setParams({ suiteId: event.target.value, sectionId: null });
            }}
          >
            {suites.map((suite) => (
              <option key={suite.id} value={suite.id}>
                {suite.name}
                {suite.is_baseline ? " (baseline)" : ""}
              </option>
            ))}
          </select>
        </div>

        <p className="label">Sections</p>
        <SectionTree
          sections={sections}
          sectionId={sectionId ? Number(sectionId) : null}
          onSelect={(nextSection) =>
            setParams({ sectionId: nextSection === null ? null : String(nextSection) })
          }
        />
      </aside>

      <section className="flex min-w-0 flex-col overflow-hidden">
        <header className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-4">
          <div className="flex min-w-60 flex-col gap-1">
            <label htmlFor="case-search" className="label">
              Search title or refs
            </label>
            <input
              id="case-search"
              type="search"
              className="field-sm"
              value={searchText}
              placeholder="login timeout"
              spellCheck={false}
              onChange={(event) => setSearchText(event.target.value)}
            />
          </div>

          <Picker
            id="type"
            label="Type"
            value={typeId}
            ids={CASE_TYPE}
            labels={CASE_TYPE_LABELS}
            onChange={(value) => setParams({ typeId: value })}
          />
          <Picker
            id="priority"
            label="Priority"
            value={priorityId}
            ids={CASE_PRIORITY}
            labels={CASE_PRIORITY_LABELS}
            onChange={(value) => setParams({ priorityId: value })}
          />

          <p className="ml-auto text-xs text-muted">
            {/* A ?page= past the end survives in a pasted link after rows move;
                "101-100 of 100" is not a range anybody can read. */}
            {firstOnPage > total
              ? total === 0
                ? "No cases"
                : `Nothing on this page of ${total}`
              : `${firstOnPage}-${lastOnPage} of ${total}`}
          </p>
        </header>

        {selected.size > 0 ? (
          <div className="flex flex-wrap items-center gap-3 border-b border-line bg-[rgba(47,224,168,0.06)] px-5 py-2">
            <p className="text-xs text-ink">{selected.size} selected</p>
            {mayEdit ? (
              <>
                <BulkPicker
                  label="Move to section"
                  disabled={busy}
                  options={sections.map((section) => ({
                    value: section.id,
                    label: `${"- ".repeat(section.depth)}${section.name}`,
                  }))}
                  onPick={(value) => applyToSelection({ sectionId: value })}
                />
                <BulkPicker
                  label="Set type"
                  disabled={busy}
                  options={Object.values(CASE_TYPE).map((id) => ({
                    value: id,
                    label: labelFor(CASE_TYPE_LABELS, id),
                  }))}
                  onPick={(value) => applyToSelection({ typeId: value })}
                />
                <BulkPicker
                  label="Set priority"
                  disabled={busy}
                  options={Object.values(CASE_PRIORITY).map((id) => ({
                    value: id,
                    label: labelFor(CASE_PRIORITY_LABELS, id),
                  }))}
                  onPick={(value) => applyToSelection({ priorityId: value })}
                />
              </>
            ) : (
              <p className="text-xs text-muted">Editing cases needs the lead role</p>
            )}
            <button type="button" className="chip" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="border-b border-alert px-5 py-2 text-sm text-alert">
            {error}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col" className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Select this page"
                    checked={rowIds.length > 0 && rowIds.every((id) => selected.has(id))}
                    onChange={() => setSelected(toggleAll(selected, rowIds))}
                  />
                </th>
                <th scope="col" className="w-16">
                  ID
                </th>
                <th scope="col">Title</th>
                <th scope="col" className="w-48">
                  Section
                </th>
                <th scope="col" className="w-24">
                  Type
                </th>
                <th scope="col" className="w-24">
                  Priority
                </th>
                <th scope="col" className="w-32">
                  Refs
                </th>
              </tr>
            </thead>
            <tbody>
              {cases?.rows.map((caseRow) => (
                <tr key={caseRow.id} data-selected={selected.has(caseRow.id)}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select case ${caseRow.id}`}
                      checked={selected.has(caseRow.id)}
                      onChange={() => undefined}
                      onClick={(event) => clickRow(event, caseRow.id)}
                    />
                  </td>
                  <td className="text-muted">{caseRow.id}</td>
                  <td className="truncate">
                    {/* The filters ride along so Back returns to this page of
                        this section, not to an unfiltered list. */}
                    <Link href={`/cases/${caseRow.id}?${searchParams.toString()}`} className="hover:text-aurora">
                      {caseRow.title}
                    </Link>
                  </td>
                  <td className="truncate text-muted">
                    {caseRow.section_id === null
                      ? "-"
                      : sectionNames.get(caseRow.section_id) ?? `#${caseRow.section_id}`}
                  </td>
                  <td className="text-muted">{labelFor(CASE_TYPE_LABELS, caseRow.type_id)}</td>
                  <td className="text-muted">
                    {labelFor(CASE_PRIORITY_LABELS, caseRow.priority_id)}
                  </td>
                  <td className="truncate text-muted">{caseRow.refs ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {cases !== null && cases.rows.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted">
              Nothing matches these filters in this suite.
            </p>
          ) : null}
        </div>

        <footer className="flex items-center gap-3 border-t border-line px-5 py-3">
          <button
            type="button"
            className="chip"
            disabled={page <= 1}
            onClick={() => setParams({ page: String(page - 1) })}
          >
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
          <label htmlFor="page-size" className="label ml-auto">
            Rows
          </label>
          <select
            id="page-size"
            className="field-sm"
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
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto flex max-w-xl flex-col gap-3 px-8 py-16">
      <p className="label">Cases</p>
      <p className="display text-2xl">{children}</p>
    </section>
  );
}

function Picker({
  id,
  label,
  value,
  ids,
  labels,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  ids: Record<string, number>;
  labels: Record<number, string>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select
        id={id}
        className="field-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Any</option>
        {Object.values(ids).map((optionId) => (
          <option key={optionId} value={optionId}>
            {labelFor(labels, optionId)}
          </option>
        ))}
      </select>
    </div>
  );
}

// Picks and fires in one gesture, then resets to its prompt: the selection is
// the subject, so the control holds no state worth keeping afterwards.
function BulkPicker({
  label,
  options,
  disabled,
  onPick,
}: {
  label: string;
  options: readonly { value: number; label: string }[];
  disabled: boolean;
  onPick: (value: number) => void;
}) {
  return (
    <select
      aria-label={label}
      className="field-sm"
      value=""
      disabled={disabled || options.length === 0}
      onChange={(event) => {
        if (event.target.value) onPick(Number(event.target.value));
      }}
    >
      <option value="">{label}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
