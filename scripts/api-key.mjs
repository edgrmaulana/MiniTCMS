/*
  API keys for CI, from the box the instance runs on:

    node scripts/api-key.mjs add <email> <name>
    node scripts/api-key.mjs list [email]
    node scripts/api-key.mjs revoke <id>

  Deliberately a CLI and not a screen. Minting a credential is an operator
  action, it happens once per CI job, and a key printed into a terminal does
  not pass through a browser history or a React state tree on the way.
*/
import {
  findUserByEmail,
  insertApiKey,
  listApiKeys,
  openDb,
  revokeApiKey,
} from "../lib/db.ts";
import { createApiKey, isValidEmail } from "../lib/auth.ts";

const [command, ...rest] = process.argv.slice(2);
const database = openDb(process.env.SQLITE_FILE ?? "./data.db");

try {
  if (command === "add") await add(...rest);
  else if (command === "list") list(rest[0]);
  else if (command === "revoke") revoke(rest[0]);
  else usage();
} catch (error) {
  // A domain error is the answer, not a crash: "already revoked" is something
  // the operator needs to read, not a stack trace to decipher.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function usage() {
  console.error("Usage: node scripts/api-key.mjs add <email> <name> | list [email] | revoke <id>");
  process.exit(1);
}

async function add(email, ...nameParts) {
  const name = nameParts.join(" ").trim();
  if (!email || !isValidEmail(email) || !name) usage();

  const owner = findUserByEmail(database, email);
  if (!owner) {
    console.error(`No user with email ${email}. Create one with npm run user:add first.`);
    process.exit(1);
  }
  if (owner.is_active !== 1) {
    console.error(`${email} is deactivated, so a key for it would never work.`);
    process.exit(1);
  }

  const { key, keyHash } = createApiKey();
  const id = insertApiKey(database, { userId: owner.id, name, keyHash });
  // Printed once. Only the hash is stored, so there is no second chance and no
  // "show key" command to write later.
  console.log(`Created key ${id} for ${owner.email} (${owner.role})`);
  console.log(key);
  console.log("Store it now. Only its hash is kept, so it cannot be shown again.");
}

function list(email) {
  let userId;
  if (email) {
    const owner = findUserByEmail(database, email);
    if (!owner) {
      console.error(`No user with email ${email}`);
      process.exit(1);
    }
    userId = owner.id;
  }
  const { rows, total } = listApiKeys(database, { userId, limit: 100 });
  if (total === 0) {
    console.log("No API keys");
    return;
  }
  for (const row of rows) {
    const state = row.revoked_on ? `revoked ${stamp(row.revoked_on)}` : "active";
    console.log(
      `${row.id}\t${row.email}\t${row.name}\t${state}\tlast used ${stamp(row.last_used_on)}`,
    );
  }
  if (total > rows.length) console.log(`... ${total - rows.length} more`);
}

function revoke(id) {
  const keyId = Number(id);
  if (!Number.isInteger(keyId) || keyId < 1) usage();
  revokeApiKey(database, keyId);
  console.log(`Revoked key ${keyId}`);
}

function stamp(seconds) {
  return seconds ? new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") : "never";
}
