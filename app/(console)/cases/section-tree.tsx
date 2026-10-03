"use client";

import { treeIndentLevel, type SectionTreeRow } from "@/lib/format";

/*
  The tree arrives from one recursive CTE already in render order, so this
  indents by `depth` and never sorts. Collapsing is not here yet: 56 sections
  scroll fine, and a collapse state is one more thing to keep in the URL.
*/
export default function SectionTree({
  sections,
  sectionId,
  onSelect,
}: {
  sections: readonly SectionTreeRow[];
  sectionId: number | null;
  onSelect: (sectionId: number | null) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5 overflow-y-auto">
      <button
        type="button"
        className="tree-row"
        aria-pressed={sectionId === null}
        onClick={() => onSelect(null)}
      >
        <span>All sections</span>
      </button>

      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          className="tree-row"
          aria-pressed={sectionId === section.id}
          onClick={() => onSelect(section.id)}
          style={{ paddingLeft: `${0.4 + treeIndentLevel(section.depth) * 0.75}rem` }}
          title={section.description ?? undefined}
        >
          <span className="truncate">{section.name}</span>
          <span className="shrink-0 text-xs text-muted">{section.case_count}</span>
        </button>
      ))}

      {sections.length === 0 ? (
        <p className="px-1 py-2 text-xs text-muted">This suite has no sections.</p>
      ) : null}
    </div>
  );
}
