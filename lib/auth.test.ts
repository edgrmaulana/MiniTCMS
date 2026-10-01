import { describe, expect, it } from "vitest";
import { randomBytes, scryptSync } from "node:crypto";
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

  /*
    A truncated or corrupted tail used to decode to zero bytes, derive a
    zero-length key, and compare equal - so every password verified against
    it. Any row the import left half-written was an account takeover.
  */
  it("never accepts a password against a hash with no derived key", async () => {
    const real = await hashPassword("the real password");
    const truncated = real.slice(0, real.lastIndexOf("$") + 1);
    expect(await verifyPassword("totally wrong", truncated)).toBe(false);
    expect(await verifyPassword("totally wrong", "scrypt$16384$8$1$c2FsdA==$")).toBe(false);
    expect(await verifyPassword("totally wrong", "scrypt$16384$8$1$c2FsdA==$!!!")).toBe(false);
  });

  it("rejects a hash whose key or salt is the wrong length", async () => {
    const shortKey = Buffer.alloc(32).toString("base64");
    const fullKey = Buffer.alloc(64).toString("base64");
    const fullSalt = Buffer.alloc(16).toString("base64");
    expect(await verifyPassword("whatever", `scrypt$16384$8$1$${fullSalt}$${shortKey}`)).toBe(false);
    expect(await verifyPassword("whatever", `scrypt$16384$8$1$c2FsdA==$${fullKey}`)).toBe(false);
  });

  it("returns false for out-of-range parameters rather than throwing", async () => {
    const key = Buffer.alloc(64).toString("base64");
    const salt = Buffer.alloc(16).toString("base64");
    for (const cost of ["3", "-1", "1e9", "24576", "0"]) {
      await expect(
        verifyPassword("whatever", `scrypt$${cost}$8$1$${salt}$${key}`),
      ).resolves.toBe(false);
    }
    for (const bad of [`scrypt$16384$0$1$${salt}$${key}`, `scrypt$16384$8$0$${salt}$${key}`]) {
      await expect(verifyPassword("whatever", bad)).resolves.toBe(false);
    }
  });

  // The stored parameters exist so the cost can be raised without
  // invalidating old hashes; this proves a hash at a higher N still verifies.
  it("verifies a hash written at a raised cost", async () => {
    const cost = 32768;
    const salt = randomBytes(16);
    const derived = scryptSync("the real password", salt, 64, {
      N: cost,
      r: 8,
      p: 1,
      maxmem: 256 * cost * 8,
    });
    const stored = `scrypt$${cost}$8$1$${salt.toString("base64")}$${derived.toString("base64")}`;
    expect(await verifyPassword("the real password", stored)).toBe(true);
    expect(await verifyPassword("not it", stored)).toBe(false);
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
