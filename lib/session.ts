import { cookies, headers } from "next/headers";
import {
  deleteExpiredSessions,
  deleteSession,
  findSessionUser,
  getDb,
  insertSession,
  nowSeconds,
} from "./db.ts";
import type { SessionUser } from "./format.ts";
import {
  createSessionToken,
  hashSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "./auth.ts";

export async function startSession(userId: number): Promise<void> {
  const { token, tokenHash } = createSessionToken();
  const expiresOn = nowSeconds() + SESSION_TTL_SECONDS;
  const requestHeaders = await headers();

  const database = getDb();
  // Swept here rather than on a schedule: a login is the only moment this
  // table reliably grows, and it keeps the deployment to one process. Move to
  // a cron if an instance ever goes months between sign-ins.
  deleteExpiredSessions(database);

  insertSession(database, {
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

export const UNKNOWN_ADDRESS = "unknown";

/*
  How many proxies you run in front of this app, from TRUSTED_PROXY_HOPS.
  Zero - the default, and what the documented compose file deploys - means
  x-forwarded-for is whatever the caller typed, because Next passes the
  client's header through untouched rather than appending the socket peer.
  Measured, not assumed: a request carrying "X-Forwarded-For: 203.0.113.99"
  arrives with exactly that value and nothing else.
*/
function trustedProxyHops(): number {
  const configured = Number(process.env.TRUSTED_PROXY_HOPS ?? 0);
  return Number.isInteger(configured) && configured > 0 ? configured : 0;
}

/*
  The address is only as trustworthy as the topology. With no proxy declared
  there is no honest answer, so this says so and the caller drops the
  address throttle rather than throttling on a value an attacker picks - a
  spoofable per-IP limit is worse than none, because it reads as protection
  while handing out a fresh bucket per request.

  With N proxies declared, the last N entries were appended by machines you
  own; the entry just before them is the furthest left that is still real.
*/
export async function clientAddress(): Promise<string> {
  const hops = trustedProxyHops();
  if (hops === 0) return UNKNOWN_ADDRESS;

  const requestHeaders = await headers();
  const forwarded = requestHeaders.get("x-forwarded-for");
  if (forwarded) {
    const chain = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    const trustworthy = chain.length - hops;
    if (trustworthy >= 0 && trustworthy < chain.length) return chain[trustworthy];
    return UNKNOWN_ADDRESS;
  }

  return requestHeaders.get("x-real-ip")?.trim() || UNKNOWN_ADDRESS;
}
