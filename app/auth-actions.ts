"use server";

import { redirect } from "next/navigation";
import {
  clearLoginAttempts,
  countLoginAttempts,
  deleteExpiredLoginAttempts,
  findUserByEmail,
  getDb,
  normaliseEmail,
  recordLoginAttempt,
} from "@/lib/db";
import {
  isValidEmail,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_SECONDS,
  verifyAgainstDecoy,
  verifyPassword,
} from "@/lib/auth";
import { clientAddress, endSession, startSession, UNKNOWN_ADDRESS } from "@/lib/session";

// The email rides back so a rejected attempt does not blank the field: React
// resets uncontrolled inputs once the action resolves.
export type LoginState = { error: string | null; email?: string };

// One message for every failure: a wrong password, an unknown account and a
// disabled account must be indistinguishable or the form becomes a user list.
const REJECTED = "Email or password is incorrect.";
const THROTTLED = "Too many attempts. Wait a few minutes and try again.";

export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  if (!isValidEmail(email) || password.length === 0 || password.length > 1024) {
    return { error: REJECTED, email };
  }

  const database = getDb();
  // Rows outside the window can never throttle anything again, and the ip:
  // identifier comes from a header, so leaving them would let a brute-force
  // run grow the table without bound.
  deleteExpiredLoginAttempts(database, LOGIN_WINDOW_SECONDS);

  const emailKey = `email:${normaliseEmail(email)}`;
  /*
    Dropped entirely when no proxy reports an address. The documented default
    deployment has no reverse proxy, so every request would share one "unknown"
    bucket: 32 failures from anyone would lock out the whole instance, and one
    success would clear the counter for an attacker.
  */
  const address = await clientAddress();
  const addressKey = address === UNKNOWN_ADDRESS ? null : `ip:${address}`;

  const throttled =
    countLoginAttempts(database, emailKey, LOGIN_WINDOW_SECONDS) >= LOGIN_MAX_ATTEMPTS ||
    (addressKey !== null &&
      countLoginAttempts(database, addressKey, LOGIN_WINDOW_SECONDS) >=
        LOGIN_MAX_ATTEMPTS * 4);
  if (throttled) return { error: THROTTLED, email };

  const user = findUserByEmail(database, email);
  const verified =
    user?.password_hash && user.is_active === 1
      ? await verifyPassword(password, user.password_hash)
      : await verifyAgainstDecoy(password);

  if (!verified || !user) {
    recordLoginAttempt(database, emailKey);
    if (addressKey !== null) recordLoginAttempt(database, addressKey);
    return { error: REJECTED, email };
  }

  clearLoginAttempts(database, emailKey);
  if (addressKey !== null) clearLoginAttempts(database, addressKey);
  await startSession(user.id);

  // redirect throws, so it stays outside anything that could swallow it.
  redirect("/");
}

export async function logout(): Promise<void> {
  await endSession();
  redirect("/login");
}
