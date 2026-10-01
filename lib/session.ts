import { cookies, headers } from "next/headers";
import {
  deleteSession,
  findSessionUser,
  getDb,
  insertSession,
  nowSeconds,
  type SessionUser,
} from "./db";
import {
  createSessionToken,
  hashSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "./auth";

export async function startSession(userId: number): Promise<void> {
  const { token, tokenHash } = createSessionToken();
  const expiresOn = nowSeconds() + SESSION_TTL_SECONDS;
  const requestHeaders = await headers();

  insertSession(getDb(), {
    tokenHash,
    userId,
    expiresOn,
    userAgent: requestHeaders.get("user-agent")?.slice(0, 255) ?? null,
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return findSessionUser(getDb(), hashSessionToken(token)) ?? null;
}

export async function endSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) deleteSession(getDb(), hashSessionToken(token));
  cookieStore.delete(SESSION_COOKIE);
}

// Only meaningful behind a proxy you control; a direct-to-internet deployment
// can have this header spoofed, so it throttles alongside the email, not alone.
export async function clientAddress(): Promise<string> {
  const requestHeaders = await headers();
  const forwarded = requestHeaders.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return requestHeaders.get("x-real-ip")?.trim() ?? "unknown";
}
