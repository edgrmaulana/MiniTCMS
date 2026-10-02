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

// Bounds for the parameters read back out of a stored hash. Outside these,
// node's scrypt throws RangeError, which would escape the server action as a
// 500 instead of a rejected sign-in.
const MIN_SCRYPT_N = 1024;
const MAX_SCRYPT_N = 1 << 22;
const MAX_SCRYPT_R = 32;
const MAX_SCRYPT_P = 16;

// 128 * N * r is the working set; node's default cap of 32MB is below what
// N=16384 r=8 already needs on the raise path, so both sides pass it.
const maxmemFor = (cost: number, blockSize: number) => 256 * cost * blockSize;

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
    maxmem: maxmemFor(SCRYPT_N, SCRYPT_R),
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

  // A power of two in range, because scrypt rejects anything else by throwing.
  const costUsable =
    Number.isInteger(cost) &&
    cost >= MIN_SCRYPT_N &&
    cost <= MAX_SCRYPT_N &&
    (cost & (cost - 1)) === 0;
  const sizesUsable =
    Number.isInteger(blockSize) &&
    blockSize > 0 &&
    blockSize <= MAX_SCRYPT_R &&
    Number.isInteger(parallel) &&
    parallel > 0 &&
    parallel <= MAX_SCRYPT_P;
  if (!costUsable || !sizesUsable) return false;

  const expected = Buffer.from(hashText, "base64");
  const salt = Buffer.from(saltText, "base64");
  /*
    The length check is the whole guard, not a sanity check. Buffer.from
    ignores invalid base64 rather than throwing, so a truncated or corrupted
    tail decodes to zero bytes; deriving a zero-length key then compares equal
    to it and every password verifies. Pin both lengths to what hashPassword
    writes and the decoded value can never be short.
  */
  if (expected.length !== SCRYPT_KEY_BYTES || salt.length !== SALT_BYTES) return false;

  const derived = await scryptAsync(password.normalize("NFKC"), salt, expected.length, {
    N: cost,
    r: blockSize,
    p: parallel,
    maxmem: maxmemFor(cost, blockSize),
  });

  return timingSafeEqual(derived, expected);
}

// Verified against this when the email is unknown, so a missing account costs
// the same wall time as a wrong password and cannot be probed for enumeration.
let decoyHash: Promise<string> | null = null;

export async function verifyAgainstDecoy(password: string): Promise<false> {
  if (!decoyHash) {
    // Cleared on rejection: a cached rejected promise would turn every later
    // unknown-email sign-in into a 500 for the life of the process.
    decoyHash = hashPassword(randomBytes(32).toString("base64")).catch((error) => {
      decoyHash = null;
      throw error;
    });
  }
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

/*
  A CI credential. Same construction as a session token - 256 bits of
  randomBytes, only the SHA-256 hash stored - with a visible prefix so a key
  that leaks into a log or a repo can be grepped for and recognised as a
  MiniTCMS secret rather than mistaken for a random string.
*/
export const API_KEY_PREFIX = "mtk_";

export function createApiKey(): { key: string; keyHash: string } {
  const key = API_KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, keyHash: hashApiKey(key) };
}

// Named apart from hashSessionToken even though the construction is identical:
// the two are looked up in different tables and a future change to one must
// not silently follow the other.
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX) && value.length > API_KEY_PREFIX.length;
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
