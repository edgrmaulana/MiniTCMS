import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  isValidEmail,
  passwordComplaint,
  verifyPassword,
} from "./auth";

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", stored)).toBe(false);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");
    expect(first).not.toBe(second);
    expect(await verifyPassword("correct horse battery staple", second)).toBe(true);
  });

  it("never stores the password in the hash string", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored).not.toContain("correct");
    expect(stored.split("$")).toHaveLength(6);
    expect(stored.startsWith("scrypt$16384$8$1$")).toBe(true);
  });

  it("rejects a malformed or truncated stored hash instead of throwing", async () => {
    expect(await verifyPassword("whatever", "")).toBe(false);
    expect(await verifyPassword("whatever", "bcrypt$1$2$3$4$5")).toBe(false);
    expect(await verifyPassword("whatever", "scrypt$x$8$1$c2FsdA==$aGFzaA==")).toBe(false);
  });
});

describe("session tokens", () => {
  it("hashes to something other than the token itself", () => {
    const { token, tokenHash } = createSessionToken();
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).toHaveLength(64);
    expect(hashSessionToken(token)).toBe(tokenHash);
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => createSessionToken().token));
    expect(tokens.size).toBe(200);
  });
});

describe("input validation", () => {
  it("accepts ordinary addresses", () => {
    expect(isValidEmail("tester@example.com")).toBe(true);
    expect(isValidEmail("first.last+tag@sub.example.co.id")).toBe(true);
  });

  it("rejects malformed addresses", () => {
    for (const bad of ["", "tester", "@example.com", "a@b", "a@@b.com", "a b@c.com"]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });

  it("holds the password floor", () => {
    expect(passwordComplaint("short")).toContain("12");
    expect(passwordComplaint("a".repeat(12))).toBeNull();
    expect(passwordComplaint("a".repeat(2000))).toContain("1024");
  });
});
