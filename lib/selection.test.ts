import { describe, expect, it } from "vitest";
import { selectRange, toggleAll, toggleSelected } from "./selection.ts";

describe("toggleSelected", () => {
  it("adds an unselected id and removes a selected one", () => {
    const added = toggleSelected(new Set([1]), 2);
    expect([...added]).toEqual([1, 2]);
    expect([...toggleSelected(added, 1)]).toEqual([2]);
  });
});

describe("selectRange", () => {
  const rowIds = [40, 10, 30, 20];

  it("selects every row between the anchor and the target in row order", () => {
    expect([...selectRange(new Set(), rowIds, 40, 30)]).toEqual([40, 10, 30]);
  });

  it("works upwards as well as downwards", () => {
    expect([...selectRange(new Set(), rowIds, 20, 10)]).toEqual([10, 30, 20]);
  });

  it("keeps what was already selected", () => {
    expect([...selectRange(new Set([99]), rowIds, 10, 10)]).toEqual([99, 10]);
  });

  it("falls back to the clicked row when the anchor is off this page", () => {
    expect([...selectRange(new Set(), rowIds, 777, 30)]).toEqual([30]);
    expect([...selectRange(new Set(), rowIds, null, 30)]).toEqual([30]);
  });
});

describe("toggleAll", () => {
  it("selects the page, then clears it, leaving other pages alone", () => {
    const page = [1, 2, 3];
    const selected = toggleAll(new Set([9]), page);
    expect([...selected]).toEqual([9, 1, 2, 3]);
    expect([...toggleAll(selected, page)]).toEqual([9]);
  });

  it("does nothing with an empty page", () => {
    expect([...toggleAll(new Set([5]), [])]).toEqual([5]);
  });
});
