"use server";

import { redirect } from "next/navigation";
import {
  clearLoginAttempts,
  countLoginAttempts,
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
import { clientAddress, endSession, startSession } from "@/lib/session";

export type LoginState = { error: string | null };

// One message for every failure: a wrong password, an unknown account and a
// disabled account must be indistinguishable or the form becomes a user list.
const REJECTED = "Email or password is incorrect.";
const THROTTLED = "Too many attempts. Wait a few minutes and try again.";

export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  if (!isValidEmail(email) || password.length === 0 || password.length > 1024) {
    return { error: REJECTED };
  }

  const database = getDb();
  const emailKey = `email:${normaliseEmail(email)}`;
  const addressKey = `ip:${await clientAddress()}`;

  const throttled =
    countLoginAttempts(database, emailKey, LOGIN_WINDOW_SECONDS) >= LOGIN_MAX_ATTEMPTS ||
    countLoginAttempts(database, addressKey, LOGIN_WINDOW_SECONDS) >= LOGIN_MAX_ATTEMPTS * 4;
  if (throttled) return { error: THROTTLED };

  const user = findUserByEmail(database, email);
  const verified =
    user?.password_hash && user.is_active === 1
      ? await verifyPassword(password, user.password_hash)
      : await verifyAgainstDecoy(password);

  if (!verified || !user) {
    recordLoginAttempt(database, emailKey);
    recordLoginAttempt(database, addressKey);
    return { error: REJECTED };
  }

  clearLoginAttempts(database, emailKey);
  clearLoginAttempts(database, addressKey);
  await startSession(user.id);

  // redirect throws, so it stays outside anything that could swallow it.
  redirect("/");
}

export async function logout(): Promise<void> {
  await endSession();
  redirect("/login");
}
