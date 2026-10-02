"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  CASE_PRIORITY,
  CASE_PRIORITY_LABELS,
  CASE_TEMPLATE,
  CASE_TYPE,
  CASE_TYPE_LABELS,
  formatTimestamp,
  labelFor,
  roleAtLeast,
  type CaseFieldRow,
  type CaseRow,
  type SectionTreeRow,
  type UserRole,
} from "@/lib/format";
import { fetchJson } from "../../../fetch-json";

type Step = { content: string; expected: string };

const TEMPLATE_LABELS: Record<number, string> = {
  [CASE_TEMPLATE.text]: "Text",
  [CASE_TEMPLATE.steps]: "Steps",
  [CASE_TEMPLATE.exploratory]: "Exploratory",
};

/*
  Edit in place, save explicitly. No autosave: a case is read by more people
  than it is written by, and a half-typed title saved on blur is worse than a
  button.

  The draft holds only what has been touched, so a field nobody edited is not
  in the PATCH at all - which is what keeps two people editing two different
  fields from overwriting each other.
*/
export default function CaseDetail({ caseId, role }: { caseId: number; role: UserRole }) {
  const mayEdit = roleAtLeast(role, "lead");
  const searchParams = useSearchParams();
  const [caseRow, setCaseRow] = useState<CaseRow | null>(null);
  const [sections, setSections] = useState<SectionTreeRow[]>([]);
  const [definitions, setDefinitions] = useState<CaseFieldRow[]>([]);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let current = true;
    fetchJson<CaseRow>(`/api/cases/${caseId}`)
      .then((row) => {
        if (current) setCaseRow(row);
      })
      .catch((reason: Error) => {
        if (current) setError(reason.message);
      });
    return () => {
      current = false;
    };
  }, [caseId]);

  useEffect(() => {
    let current = true;
    fetchJson<{ rows: CaseFieldRow[] }>("/api/case-fields")
      .then((result) => {
        if (current) setDefinitions(result.rows);
      })
      .catch((reason: Error) => {
        if (current) setError(reason.message);
      });
    return () => {
      current = false;
    };
  }, []);

  const suiteId = caseRow?.suite_id;
  useEffect(() => {
    if (suiteId === undefined) return;
    let current = true;
    fetchJson<{ rows: SectionTreeRow[] }>(`/api/suites/${suiteId}/sections`)
      .then((result) => {
        if (current) setSections(result.rows);
      })
      .catch((reason: Error) => {
        if (current) setError(reason.message);
      });
    return () => {
      current = false;
    };
  }, [suiteId]);

  const custom = useMemo(() => parseCustom(caseRow?.custom), [caseRow?.custom]);

  if (error && !caseRow) {
    return (
      <section className="flex flex-col gap-3 px-8 py-16">
        <p role="alert" className="text-sm text-alert">
          {error}
        </p>
        <Link href="/cases" className="chip w-32 text-center">
          Back to cases
        </Link>
      </section>
    );
  }
  if (!caseRow) return <p className="px-8 py-16 text-sm text-muted">Loading case</p>;

  const storedSteps = asSteps(custom.steps);
  const editedSteps = steps ?? storedSteps;
  const stepsChanged = steps !== null && JSON.stringify(steps) !== JSON.stringify(storedSteps);
  const dirty = Object.keys(draft).length > 0 || stepsChanged;

  /*
    `custom` is one column, so saving a step means sending the whole bag back,
    and the API refuses a bag holding a key with no row in case_fields - which
    is exactly what a TestRail import leaves behind for an unmapped field.
    Rather than offer an edit that would be rejected on save, the table goes
    read-only and names the keys that have to be defined first.
  */
  const defined = new Set(definitions.map((definition) => definition.system_name));
  const undefinedKeys = Object.keys(custom).filter((key) => !defined.has(key));
  const stepsEditable = undefinedKeys.length === 0;

  function edit(field: string, value: unknown) {
    setSaved(false);
    setDraft((previous) => ({ ...previous, [field]: value }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = { ...draft };
      // The whole bag goes back when a step changed, because `custom` is one
      // column: sending half of it would delete the other half.
      if (stepsChanged) patch.custom = { ...custom, steps: editedSteps };
      const updated = await fetchJson<CaseRow>(`/api/cases/${caseId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      setCaseRow(updated);
      setDraft({});
      setSteps(null);
      setSaved(true);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const value = <Field extends keyof CaseRow>(field: Field, key: string) =>
    (draft[key] !== undefined ? draft[key] : caseRow[field]) as CaseRow[Field];

  const backHref = searchParams.toString() ? `/cases?${searchParams.toString()}` : "/cases";

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4">
        <Link href={backHref} className="chip">
          Back
        </Link>
        <p className="label">Case {caseRow.id}</p>
        {caseRow.source ? (
          <span className="pill text-muted">
            {caseRow.source} #{caseRow.source_id}
          </span>
        ) : null}
        <span className="pill text-violet">{TEMPLATE_LABELS[caseRow.template_id] ?? `Template ${caseRow.template_id}`}</span>
        <div className="ml-auto flex items-center gap-3">
          {saved ? <p className="text-xs text-aurora">Saved</p> : null}
          {mayEdit ? (
            <button type="button" className="signin px-4 py-2" disabled={!dirty || busy} onClick={save}>
              {busy ? "Saving" : "Save"}
            </button>
          ) : (
            <p className="text-xs text-muted">Read-only: editing a case needs the lead role</p>
          )}
        </div>
      </header>

      {error ? (
        <p role="alert" className="border-b border-alert px-6 py-2 text-sm text-alert">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {/* One fieldset instead of a disabled prop on two dozen controls: the
            browser propagates this to every input inside it, and `contents`
            keeps it out of the layout. */}
        <fieldset disabled={!mayEdit} className="contents">
          <div className="flex max-w-5xl flex-col gap-6">
            <div className="flex flex-col gap-2">
              <label htmlFor="title" className="label">
                Title
              </label>
              <input
                id="title"
                className="field"
                value={String(value("title", "title") ?? "")}
                onChange={(event) => edit("title", event.target.value)}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <label htmlFor="section" className="label">
                  Section
                </label>
                <select
                  id="section"
                  className="field-sm"
                  value={String(value("section_id", "sectionId") ?? "")}
                  onChange={(event) =>
                    edit("sectionId", event.target.value === "" ? null : Number(event.target.value))
                  }
                >
                  <option value="">No section</option>
                  {sections.map((section) => (
                    <option key={section.id} value={section.id}>
                      {"- ".repeat(section.depth)}
                      {section.name}
                    </option>
                  ))}
                </select>
              </div>

              <IdPicker
                id="type"
                label="Type"
                ids={CASE_TYPE}
                labels={CASE_TYPE_LABELS}
                value={value("type_id", "typeId") as number | null}
                onChange={(next) => edit("typeId", next)}
              />
              <IdPicker
                id="priority"
                label="Priority"
                ids={CASE_PRIORITY}
                labels={CASE_PRIORITY_LABELS}
                value={value("priority_id", "priorityId") as number | null}
                onChange={(next) => edit("priorityId", next)}
              />

              <div className="flex flex-col gap-2">
                <label htmlFor="refs" className="label">
                  References
                </label>
                <input
                  id="refs"
                  className="field-sm"
                  value={String(value("refs", "refs") ?? "")}
                  placeholder="BUG-1024"
                  onChange={(event) => edit("refs", event.target.value === "" ? null : event.target.value)}
                />
              </div>

              <div className="flex flex-col gap-2">
                <label htmlFor="estimate" className="label">
                  Estimate
                </label>
                <input
                  id="estimate"
                  className="field-sm"
                  value={String(value("estimate", "estimate") ?? "")}
                  placeholder="1m 45s"
                  onChange={(event) =>
                    edit("estimate", event.target.value === "" ? null : event.target.value)
                  }
                />
              </div>
            </div>

            <section className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <p className="label">Steps</p>
                {stepsEditable ? (
                  <button
                    type="button"
                    className="chip"
                    onClick={() => setSteps([...editedSteps, { content: "", expected: "" }])}
                  >
                    Add step
                  </button>
                ) : (
                  <p className="text-xs text-muted">
                    Read-only: {undefinedKeys.join(", ")} {undefinedKeys.length === 1 ? "has" : "have"} no
                    field definition, and a save would be refused until {undefinedKeys.length === 1 ? "it does" : "they do"}.
                  </p>
                )}
              </div>
              {editedSteps.length === 0 ? (
                <p className="text-sm text-muted">This case has no step table.</p>
              ) : (
                <table className="grid-table sheet">
                  <thead>
                    <tr>
                      <th scope="col" className="w-10">
                        #
                      </th>
                      <th scope="col">Step</th>
                      <th scope="col">Expected result</th>
                      <th scope="col" className="w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {editedSteps.map((step, index) => (
                      <tr key={index}>
                        <td className="text-muted">{index + 1}</td>
                        <td>
                          {stepsEditable ? (
                            <textarea
                              className="field-sm w-full"
                              rows={2}
                              value={step.content}
                              aria-label={`Step ${index + 1}`}
                              onChange={(event) =>
                                setSteps(replaceStep(editedSteps, index, { content: event.target.value }))
                              }
                            />
                          ) : (
                            <span className="whitespace-pre-wrap">{step.content}</span>
                          )}
                        </td>
                        <td>
                          {stepsEditable ? (
                            <textarea
                              className="field-sm w-full"
                              rows={2}
                              value={step.expected}
                              aria-label={`Expected result ${index + 1}`}
                              onChange={(event) =>
                                setSteps(replaceStep(editedSteps, index, { expected: event.target.value }))
                              }
                            />
                          ) : (
                            <span className="whitespace-pre-wrap">{step.expected}</span>
                          )}
                        </td>
                        <td>
                          {stepsEditable ? (
                            <button
                              type="button"
                              className="chip"
                              onClick={() => setSteps(editedSteps.filter((_, at) => at !== index))}
                            >
                              Remove
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <CustomFields custom={custom} definitions={definitions} />

            <dl className="grid gap-2 border-t border-line pt-4 text-xs text-muted md:grid-cols-2">
              <div>
                <dt className="label">Created</dt>
                <dd>{formatTimestamp(caseRow.created_on)}</dd>
              </div>
              <div>
                <dt className="label">Last updated</dt>
                <dd>{formatTimestamp(caseRow.updated_on)}</dd>
              </div>
            </dl>
          </div>
        </fieldset>
      </div>
    </div>
  );
}

function IdPicker({
  id,
  label,
  ids,
  labels,
  value,
  onChange,
}: {
  id: string;
  label: string;
  ids: Record<string, number>;
  labels: Record<number, string>;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select
        id={id}
        className="field-sm"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
      >
        <option value="">Not set</option>
        {Object.values(ids).map((optionId) => (
          <option key={optionId} value={optionId}>
            {labelFor(labels, optionId)}
          </option>
        ))}
      </select>
      {value !== null && !labels[value] ? (
        // An imported id this instance has no name for is shown, not hidden.
        <p className="text-xs text-muted">Stored as {value}</p>
      ) : null}
    </div>
  );
}

/*
  Read-only, and deliberately so for now: a custom bag that still holds keys
  with no row in case_fields - which is exactly what a TestRail import leaves
  behind - is refused by PATCH, and a save button that fails on half the
  migrated cases is worse than a value you can read and copy. Editing arrives
  with the field-definition screen.
*/
function CustomFields({
  custom,
  definitions,
}: {
  custom: Record<string, unknown>;
  definitions: readonly CaseFieldRow[];
}) {
  const entries = Object.entries(custom).filter(([key]) => key !== "steps");
  if (entries.length === 0) return null;
  const labels = new Map(definitions.map((definition) => [definition.system_name, definition.label]));

  return (
    <section className="flex flex-col gap-2">
      <p className="label">Custom fields</p>
      <dl className="grid gap-3 md:grid-cols-2">
        {entries.map(([key, value]) => (
          <div key={key} className="sheet px-3 py-2">
            <dt className="text-xs text-muted">{labels.get(key) ?? key}</dt>
            <dd className="whitespace-pre-wrap text-sm">
              {typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function parseCustom(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// TestRail's step table comes over as objects with content and expected; a row
// missing either still renders rather than blanking the whole table.
function asSteps(value: unknown): Step[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const step = (entry ?? {}) as Record<string, unknown>;
    return {
      content: typeof step.content === "string" ? step.content : "",
      expected: typeof step.expected === "string" ? step.expected : "",
    };
  });
}

function replaceStep(steps: readonly Step[], index: number, patch: Partial<Step>): Step[] {
  return steps.map((step, at) => (at === index ? { ...step, ...patch } : step));
}
