/*
  Multi-select arithmetic for the case table, kept out of the component so the
  shift-range rule is testable without a DOM. The row order is passed in
  because a range means "everything between these two rows as rendered", which
  is the section_id/id order listCases returns and not the numeric id order.
*/

export function toggleSelected(
  selected: ReadonlySet<number>,
  id: number,
): Set<number> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/*
  Adds, never removes: a shift-click extends a selection. With no anchor, or an
  anchor that has scrolled off onto another page, the clicked row is all we can
  honestly say was selected.
*/
export function selectRange(
  selected: ReadonlySet<number>,
  rowIds: readonly number[],
  anchorId: number | null,
  targetId: number,
): Set<number> {
  const next = new Set(selected);
  const anchorIndex = anchorId === null ? -1 : rowIds.indexOf(anchorId);
  const targetIndex = rowIds.indexOf(targetId);
  if (anchorIndex === -1 || targetIndex === -1) {
    next.add(targetId);
    return next;
  }
  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  for (let index = from; index <= to; index += 1) next.add(rowIds[index]);
  return next;
}

// Selecting the page, not the table: a header checkbox that silently picked up
// 50k rows behind a bulk move would be the most expensive click in the product.
export function toggleAll(
  selected: ReadonlySet<number>,
  rowIds: readonly number[],
): Set<number> {
  const allSelected = rowIds.length > 0 && rowIds.every((id) => selected.has(id));
  const next = new Set(selected);
  for (const id of rowIds) {
    if (allSelected) next.delete(id);
    else next.add(id);
  }
  return next;
}
