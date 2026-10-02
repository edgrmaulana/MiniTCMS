import { describe, expect, it } from "vitest";
import { actionForKey, type KeyContext } from "./keys.ts";
import { BUILT_IN_STATUSES, RESULT_STATUS, type StatusRow } from "./format.ts";

const BUILT_INS: StatusRow[] = BUILT_IN_STATUSES.map((status) => ({
  id: status.id,
  system_name: status.systemName,
  label: status.label,
  color: status.color,
  is_untested: status.isUntested,
  is_final: status.isFinal,
}));

const CUSTOM: StatusRow[] = [
  { id: 7, system_name: "custom_status2", label: "Needs review", color: "#6b6ff0", is_untested: 0, is_final: 0 },
  { id: 6, system_name: "custom_status1", label: "Deferred", color: "#8793ab", is_untested: 0, is_final: 1 },
];

function context(overrides: Partial<KeyContext> = {}): KeyContext {
  return { statuses: BUILT_INS, selectionSize: 0, runClosed: false, ...overrides };
}

describe("actionForKey", () => {
  it("moves the cursor on j/k and the arrows", () => {
    expect(actionForKey("j", context())).toEqual({ kind: "move", delta: 1 });
    expect(actionForKey("ArrowDown", context())).toEqual({ kind: "move", delta: 1 });
    expect(actionForKey("k", context())).toEqual({ kind: "move", delta: -1 });
    expect(actionForKey("ArrowUp", context())).toEqual({ kind: "move", delta: -1 });
  });

  it("records the cursor row with no selection", () => {
    expect(actionForKey("1", context())).toEqual({
      kind: "record",
      statusId: RESULT_STATUS.passed,
      scope: "cursor",
      wantsComment: false,
    });
  });

  it("records the whole selection when one is active", () => {
    expect(actionForKey("5", context({ selectionSize: 3 }))).toEqual({
      kind: "record",
      statusId: RESULT_STATUS.failed,
      scope: "selection",
      wantsComment: true,
    });
  });

  it("asks for a comment on failed and blocked, and not on the others", () => {
    expect(actionForKey("5", context())).toMatchObject({ wantsComment: true });
    expect(actionForKey("2", context())).toMatchObject({ wantsComment: true });
    expect(actionForKey("4", context())).toMatchObject({ wantsComment: false });
  });

  it("leaves 3 unbound, because untested is not a result", () => {
    expect(actionForKey("3", context())).toBeNull();
  });

  it("refuses a status key on a closed run, with a reason", () => {
    expect(actionForKey("1", context({ runClosed: true }))).toMatchObject({ kind: "refused" });
    // Everything that does not write still works on a closed run.
    expect(actionForKey("j", context({ runClosed: true }))).toEqual({ kind: "move", delta: 1 });
    expect(actionForKey("/", context({ runClosed: true }))).toEqual({ kind: "focusFilter" });
  });

  it("maps 6 upwards to the custom statuses in id order", () => {
    const withCustom = context({ statuses: [...BUILT_INS, ...CUSTOM] });
    expect(actionForKey("6", withCustom)).toMatchObject({ statusId: 6 });
    expect(actionForKey("7", withCustom)).toMatchObject({ statusId: 7 });
    expect(actionForKey("8", withCustom)).toBeNull();
  });

  it("leaves the custom keys unbound when the instance has no custom statuses", () => {
    expect(actionForKey("6", context())).toBeNull();
    expect(actionForKey("9", context())).toBeNull();
  });

  it("binds the rest of the map", () => {
    expect(actionForKey(" ", context())).toEqual({ kind: "openPanel" });
    expect(actionForKey("Enter", context())).toEqual({ kind: "recordAndAdvance" });
    expect(actionForKey("x", context())).toEqual({ kind: "toggleSelect" });
    expect(actionForKey("Escape", context())).toEqual({ kind: "clearSelection" });
    expect(actionForKey("q", context())).toBeNull();
  });
});
