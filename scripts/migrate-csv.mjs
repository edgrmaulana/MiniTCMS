/*
  CSV import: node scripts/migrate-csv.mjs <file> --project <id> --tz <zone>
              --date-order mdy|dmy [--dry-run] [--users name=email,...]
              [--allow-mixed-sources]

  --tz and --date-order have no defaults on purpose. "1/2/2026" is either
  January 2nd or February 1st depending on the exporting user's account
  settings, and nothing in the file says which; guessing silently moves
  every date in the import by up to eleven months.
*/
import { readFileSync } from "node:fs";
import { openDb, getProject } from "../lib/db.ts";
import { runCsvImport } from "../lib/migrate/import-csv.ts";
import { formatReport } from "../lib/migrate/report.ts";
import { DATE_ORDERS, isDateOrder, isValidTimeZone, parseUserMap } from "../lib/migrate/map.ts";

const USAGE = `Usage: node scripts/migrate-csv.mjs <file> --project <id> --tz <zone> \\
  --date-order ${DATE_ORDERS.join("|")} [--dry-run] [--users name=email,...] [--allow-mixed-sources]`;

const argv = process.argv.slice(2);
const file = argv.find((argument) => !argument.startsWith("--"));
const flags = readFlags(argv);

if (!file) fail(USAGE);

const projectId = Number(flags.get("project"));
if (!Number.isInteger(projectId) || projectId < 1) {
  fail(`--project <id> is required: the CSV has no project column.\n${USAGE}`);
}

const timeZone = flags.get("tz");
if (!timeZone) fail(`--tz is required: the CSV timestamps carry no offset.\n${USAGE}`);
if (!isValidTimeZone(timeZone)) fail(`"${timeZone}" is not an IANA time zone name, e.g. Asia/Jakarta`);

const dateOrder = flags.get("date-order");
if (!dateOrder || !isDateOrder(dateOrder)) {
  fail(`--date-order must be one of ${DATE_ORDERS.join(", ")}: "1/2/2026" is ambiguous without it.`);
}

const userMapArgument = flags.get("users");
let userMap;
try {
  userMap = userMapArgument ? parseUserMap(userMapArgument) : undefined;
} catch (error) {
  fail(error.message);
}

const database = openDb(process.env.SQLITE_FILE ?? "./data.db");
const project = getProject(database, projectId);
if (!project) fail(`No project with id ${projectId}. Create it first.`);

const dryRun = flags.has("dry-run");
console.log(
  `${dryRun ? "Dry run" : "Importing"} ${file} into project ${projectId} (${project.name}), ` +
    `${timeZone}, ${dateOrder}`,
);

try {
  const { importRunId, report } = runCsvImport(database, readFileSync(file, "utf8"), {
    projectId,
    timeZone,
    dateOrder,
    userMap,
    dryRun,
    allowMixedSources: flags.has("allow-mixed-sources"),
  });
  console.log("");
  console.log(formatReport(report));
  console.log(`\nimport run ${importRunId}`);
} catch (error) {
  console.error(`\nImport failed: ${error.message}`);
  process.exit(1);
}

function readFlags(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) continue;
    const name = argument.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(name, "");
      continue;
    }
    flags.set(name, next);
    index += 1;
  }
  return flags;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
