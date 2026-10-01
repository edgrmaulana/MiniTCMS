// Account bootstrap: node scripts/create-user.mjs <email> <role>
// The password is read from stdin, never from argv, so it stays out of the
// shell history and out of the process list.
import { createInterface } from "node:readline";
import { openDb, createUser, findUserByEmail } from "../lib/db.ts";
import { hashPassword, isValidEmail, passwordComplaint } from "../lib/auth.ts";
import { USER_ROLES, isUserRole } from "../lib/format.ts";

const [email, role = "admin"] = process.argv.slice(2);

if (!email || !isValidEmail(email)) {
  console.error(`Usage: node scripts/create-user.mjs <email> [${USER_ROLES.join("|")}]`);
  process.exit(1);
}
if (!isUserRole(role)) {
  console.error(`Unknown role: ${role}. Expected one of ${USER_ROLES.join(", ")}.`);
  process.exit(1);
}

const password = await readPassword();
const complaint = passwordComplaint(password);
if (complaint) {
  console.error(complaint);
  process.exit(1);
}

const database = openDb(process.env.SQLITE_FILE ?? "./data.db");
if (findUserByEmail(database, email)) {
  console.error(`User already exists: ${email}`);
  process.exit(1);
}

const id = createUser(database, {
  email,
  role,
  passwordHash: await hashPassword(password),
});
console.log(`Created user ${id}: ${email} (${role})`);

function readPassword() {
  const input = createInterface({ input: process.stdin, terminal: false });
  return new Promise((resolve, reject) => {
    let value = "";
    input.on("line", (line) => {
      value = line;
      input.close();
    });
    input.on("close", () => resolve(value));
    input.on("error", reject);
  });
}
