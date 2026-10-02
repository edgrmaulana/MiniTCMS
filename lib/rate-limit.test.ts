import { describe, expect, it } from "vitest";
import {
  API_RATE_LIMIT,
  API_RATE_WINDOW_SECONDS,
  pruneWindows,
  takeToken,
  type RateWindow,
} from "./rate-limit.ts";

describe("takeToken", () => {
  it("allows up to the limit and then refuses", () => {
    const windows = new Map<string, RateWindow>();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(takeToken(windows, "key-a", 1000, 3, 60).allowed).toBe(true);
    }
    const refused = takeToken(windows, "key-a", 1000, 3, 60);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.resetAt).toBe(1060);
  });

  it("counts down the remaining allowance", () => {
    const windows = new Map<string, RateWindow>();
    expect(takeToken(windows, "key-a", 1000, 3, 60).remaining).toBe(2);
    expect(takeToken(windows, "key-a", 1000, 3, 60).remaining).toBe(1);
  });

  it("starts a fresh window once the old one has passed", () => {
    const windows = new Map<string, RateWindow>();
    takeToken(windows, "key-a", 1000, 1, 60);
    expect(takeToken(windows, "key-a", 1059, 1, 60).allowed).toBe(false);
    const after = takeToken(windows, "key-a", 1060, 1, 60);
    expect(after.allowed).toBe(true);
    expect(after.resetAt).toBe(1120);
  });

  it("keeps one allowance per key", () => {
    const windows = new Map<string, RateWindow>();
    takeToken(windows, "key-a", 1000, 1, 60);
    expect(takeToken(windows, "key-b", 1000, 1, 60).allowed).toBe(true);
    expect(takeToken(windows, "key-a", 1000, 1, 60).allowed).toBe(false);
  });

  it("defaults to the shipped limit and window", () => {
    const windows = new Map<string, RateWindow>();
    const first = takeToken(windows, "key-a", 1000);
    expect(first.remaining).toBe(API_RATE_LIMIT - 1);
    expect(first.resetAt).toBe(1000 + API_RATE_WINDOW_SECONDS);
  });
});

describe("pruneWindows", () => {
  it("leaves a small map alone", () => {
    const windows = new Map<string, RateWindow>([["key-a", { count: 1, resetAt: 10 }]]);
    pruneWindows(windows, 1000);
    expect(windows.size).toBe(1);
  });

  it("drops expired windows once the map is large", () => {
    const windows = new Map<string, RateWindow>();
    for (let index = 0; index < 1001; index += 1) {
      windows.set(`expired-${index}`, { count: 1, resetAt: 500 });
    }
    windows.set("live", { count: 1, resetAt: 2000 });
    pruneWindows(windows, 1000);
    expect(windows.size).toBe(1);
    expect(windows.has("live")).toBe(true);
  });
});
