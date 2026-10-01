import { describe, expect, it } from "vitest";
import {
  BUILT_IN_STATUSES,
  clampPage,
  clampPageSize,
  DEFAULT_PAGE_SIZE,
  FIRST_CUSTOM_STATUS_ID,
  MAX_PAGE,
  offsetFor,
  PAGE_SIZES,
  RESULT_STATUS,
} from "./format";

describe("result statuses", () => {
  it("keeps TestRail's five built-in ids", () => {
    expect(RESULT_STATUS).toEqual({
      passed: 1,
      blocked: 2,
      untested: 3,
      retest: 4,
      failed: 5,
    });
  });

  it("leaves the custom range free", () => {
    const highest = Math.max(...BUILT_IN_STATUSES.map((status) => status.id));
    expect(FIRST_CUSTOM_STATUS_ID).toBeGreaterThan(highest);
  });

  it("describes every built-in exactly once", () => {
    const ids = BUILT_IN_STATUSES.map((status) => status.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(Object.values(RESULT_STATUS).sort());
  });
});

describe("pagination clamps", () => {
  it("snaps an off-menu limit to the default", () => {
    for (const rejected of [0, -1, 7, 101, 100000, NaN, "all", null, undefined]) {
      expect(clampPageSize(rejected), String(rejected)).toBe(DEFAULT_PAGE_SIZE);
    }
  });

  it("keeps a limit that is on the menu", () => {
    for (const allowed of PAGE_SIZES) {
      expect(clampPageSize(allowed)).toBe(allowed);
      expect(clampPageSize(String(allowed))).toBe(allowed);
    }
  });

  it("floors the page to 1", () => {
    for (const rejected of [0, -3, 0.5, NaN, "first", null, undefined]) {
      expect(clampPage(rejected), String(rejected)).toBe(1);
    }
    expect(clampPage(4)).toBe(4);
    expect(clampPage("4")).toBe(4);
  });

  it("never produces a negative offset", () => {
    expect(offsetFor(1, 25)).toBe(0);
    expect(offsetFor(3, 25)).toBe(50);
    expect(offsetFor(-9, 25)).toBe(0);
  });
});

describe("page ceiling", () => {
  it("caps an absurd page instead of producing an unbindable offset", () => {
    expect(clampPage(1e308)).toBe(MAX_PAGE);
    expect(Number.isSafeInteger(offsetFor(1e308, 25))).toBe(true);
    expect(Number.isSafeInteger(offsetFor("9007199254740993", 100))).toBe(true);
  });

  it("clamps the limit itself rather than trusting the caller", () => {
    expect(offsetFor(2, NaN)).toBe(DEFAULT_PAGE_SIZE);
    expect(offsetFor(2, 7)).toBe(DEFAULT_PAGE_SIZE);
    expect(offsetFor(3, 50)).toBe(100);
  });
});
