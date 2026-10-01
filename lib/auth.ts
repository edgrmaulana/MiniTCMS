import {
  randomBytes,
  createHash,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";

// promisify drops the options overload, so the options form is typed back on.
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

// OWASP-recommended scrypt floor. Never lower N to make tests faster.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 64;
const SALT_BYTES = 16;

export const SESSION_COOKIE = "minitcms_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_MAX_ATTEMPTS = 8;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password.normalize("NFKC"), salt, SCRYPT_KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, costText, blockText, parallelText, saltText, hashText] = parts;
  const cost = Number(costText);
  const blockSize = Number(blockText);
  const parallel = Number(parallelText);
  if (!Number.isFinite(cost) || !Number.isFinite(blockSize) || !Number.isFinite(parallel)) {
    return false;
  }

  const expected = Buffer.from(hashText, "base64");
  const derived = await scryptAsync(
    password.normalize("NFKC"),
    Buffer.from(saltText, "base64"),
    expected.length,
    // maxmem must cover 128 * N * r, which exceeds the 32MB default past N=16384.
    { N: cost, r: blockSize, p: parallel, maxmem: 256 * cost * blockSize },
  );

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// Verified against this when the email is unknown, so a missing account costs
// the same wall time as a wrong password and cannot be probed for enumeration.
let decoyHash: Promise<string> | null = null;

export async function verifyAgainstDecoy(password: string): Promise<false> {
  if (!decoyHash) decoyHash = hashPassword(randomBytes(32).toString("base64"));
  await verifyPassword(password, await decoyHash);
  return false;
}

export function createSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
}

// Only the hash is stored: a leaked database read does not hand over live sessions.
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isValidEmail(email: string): boolean {
  const trimmed = email.trim();
  if (trimmed.length < 3 || trimmed.length > 254) return false;
  if (/\s/.test(trimmed)) return false;
  const atIndex = trimmed.indexOf("@");
  if (atIndex < 1 || atIndex !== trimmed.lastIndexOf("@")) return false;
  const domain = trimmed.slice(atIndex + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

export const MIN_PASSWORD_LENGTH = 12;

export function passwordComplaint(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 1024) return "Password must be at most 1024 characters.";
  return null;
}
