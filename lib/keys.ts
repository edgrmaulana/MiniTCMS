/*
  The run screen's keyboard map, as a pure function: a keystroke plus what the
  screen currently holds, in, an action out. No DOM, no fetch, so the awkward
  parts - which digit means which status, what a digit does on a closed run,
  what happens with a selection active - are testable without a browser.

  The digits are TestRail's own status ids, which is why 3 is unbound: untested
  is the absence of a result, not one that can be recorded. Custom statuses
  take 6 upwards in id order, the same order TestRail hands them out in.
*/

import { FIRST_CUSTOM_STATUS_ID, isAssignableStatus, needsComment, type StatusRow } from "./format.ts";

export type KeyAction =
  | { kind: "move"; delta: number }
  | { kind: "record"; statusId: number; scope: "cursor" | "selection"; wantsComment: boolean }
  | { kind: "openPanel" }
  | { kind: "recordAndAdvance" }
  | { kind: "toggleSelect" }
  | { kind: "clearSelection" }
  | { kind: "focusFilter" }
  | { kind: "refused"; reason: string }
  | null;

export type KeyContext = {
  statuses: readonly StatusRow[];
  selectionSize: number;
  runClosed: boolean;
};

const MOVEMENT: Record<string, number> = {
  j: 1,
  ArrowDown: 1,
  k: -1,
  ArrowUp: -1,
};

const BUILT_IN_KEYS = ["1", "2", "3", "4", "5"] as const;

const CUSTOM_KEYS = ["6", "7", "8", "9"] as const;

export function actionForKey(key: string, context: KeyContext): KeyAction {
  const movement = MOVEMENT[key];
  if (movement !== undefined) return { kind: "move", delta: movement };

  switch (key) {
    case "x":
      return { kind: "toggleSelect" };
    case "Escape":
      return { kind: "clearSelection" };
    case "/":
      return { kind: "focusFilter" };
    case " ":
      return { kind: "openPanel" };
    case "Enter":
      return { kind: "recordAndAdvance" };
    default:
      break;
  }

  const statusId = statusIdForKey(key, context.statuses);
  if (statusId === null) return null;

  // Said here rather than discovered by the server after the keystroke: a
  // closed run that answers 409 three keys later looks like a lost result.
  if (context.runClosed) {
    return { kind: "refused", reason: "This run is closed. Reopen it to record results." };
  }

  return {
    kind: "record",
    statusId,
    scope: context.selectionSize > 0 ? "selection" : "cursor",
    wantsComment: needsComment(statusId),
  };
}

function statusIdForKey(key: string, statuses: readonly StatusRow[]): number | null {
  if ((BUILT_IN_KEYS as readonly string[]).includes(key)) {
    const status = statuses.find((candidate) => candidate.id === Number(key));
    // An unassignable status - untested on 3 - has no key, and neither does a
    // built-in id this instance does not have.
    return status && isAssignableStatus(status) ? status.id : null;
  }

  const customIndex = (CUSTOM_KEYS as readonly string[]).indexOf(key);
  if (customIndex === -1) return null;

  const custom = statuses
    .filter((status) => status.id >= FIRST_CUSTOM_STATUS_ID && isAssignableStatus(status))
    .sort((left, right) => left.id - right.id);
  return custom[customIndex]?.id ?? null;
}
