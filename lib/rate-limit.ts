/*
  Per-key request limiting for the CI-facing API. A runaway reporter in a loop
  should get 429s, not take the instance down - SQLite serialises writes, so one
  job hammering POST /api/results blocks every human on the console.

  ponytail: in-process fixed window, not a table. A counter row per request
  would mean a write for every read, which is the problem rather than the fix,
  and the documented deployment is one container with one node process. The
  ceiling is explicit: run two processes and each gets its own allowance.
  Upgrade path is a SQLite bucket table keyed by (key_hash, window_start), or
  Redis if someone ever runs this at a size where that matters.
*/

export const API_RATE_LIMIT = 300;
export const API_RATE_WINDOW_SECONDS = 60;

export type RateWindow = { count: number; resetAt: number };

export type RateDecision = { allowed: boolean; remaining: number; resetAt: number };

/*
  Fixed window rather than a sliding one: a sliding window needs the timestamps
  kept, and the only thing this has to guarantee is that an unattended loop
  cannot issue unbounded work. Pure over the map it is handed, so the window
  edges are tested without touching the clock.
*/
export function takeToken(
  windows: Map<string, RateWindow>,
  key: string,
  now: number,
  limit: number = API_RATE_LIMIT,
  windowSeconds: number = API_RATE_WINDOW_SECONDS,
): RateDecision {
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowSeconds;
    windows.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt };
  }
  if (existing.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt };
  }
  existing.count += 1;
  return { allowed: true, remaining: limit - existing.count, resetAt: existing.resetAt };
}

// Dropped on every call that finds the map large, so a long-lived process does
// not hold a window per key it has ever seen. Keys are already bounded - a
// window is only created for a key that exists in the database - but a bound
// that depends on another table's size is not one worth relying on.
const PRUNE_ABOVE = 1_000;

export function pruneWindows(windows: Map<string, RateWindow>, now: number): void {
  if (windows.size <= PRUNE_ABOVE) return;
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

const liveWindows = new Map<string, RateWindow>();

export function takeApiToken(keyHash: string, now: number): RateDecision {
  pruneWindows(liveWindows, now);
  return takeToken(liveWindows, keyHash, now);
}
