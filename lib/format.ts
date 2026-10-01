// Shared types and constants. Imported by client components as well as the
// server, so nothing here may touch node: builtins or the database.

export const USER_ROLES = ["admin", "lead", "tester"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}

export type UserRow = {
  id: number;
  email: string;
  name: string | null;
  role: UserRole;
  is_active: number;
  password_hash: string | null;
  created_on: number;
};

export type SessionUser = {
  userId: number;
  email: string;
  name: string | null;
  role: UserRole;
  expiresOn: number;
};
