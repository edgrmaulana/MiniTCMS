/*
  TestRail API import:
    node scripts/migrate.mjs [--dry-run] [--resume <importRunId>]
                             [--project <testrailProjectId>] [--allow-mixed-sources]

  Credentials come from the environment only - TESTRAIL_HOST, TESTRAIL_USER,
  TESTRAIL_API_KEY, and TESTRAIL_RPS to throttle. The key is an API key, not
  the account password: TestRail issues one per user under My Settings.

  This is the real interface for the API path. A full instance is tens of
  thousands of calls and minutes to hours of work, which is a terminal job,
  not a request a browser holds open.
*/
import { openDb } from "../lib/db.ts";
import { testRailClientFromEnv } from "../lib/testrail.ts";
import { runApiImport } from "../lib/migrate/run.ts";
import { formatReport } from "../lib/migrate/report.ts";

const argv = process.argv.slice(2);
const flags = readFlags(argv);

const dryRun = flags.has("dry-run");
const resumeFrom = flags.has("resume") ? Number(flags.get("resume")) : undefined;
if (resumeFrom !== undefined && (!Number.isInteger(resumeFrom) || resumeFrom < 1)) {
  fail("--resume takes the id of a previous import run");
}

const projectSourceIds = (flags.get("project") ?? "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

let client;
try {
  client = testRailClientFromEnv();
} catch (error) {
  fail(`${error.message}\nSet them in .env.local; see README.md.`);
}

const database = openDb(process.env.SQLITE_FILE ?? "./data.db");

console.log(
  `${dryRun ? "Dry run" : "Importing"} from ${process.env.TESTRAIL_HOST}` +
    `${projectSourceIds.length > 0 ? `, projects ${projectSourceIds.join(", ")}` : ", every project"}` +
    `${resumeFrom ? `, resuming import run ${resumeFrom}` : ""}`,
);

// Captured before the first fetch, so a failure can name the run to resume.
let startedRunId;

try {
  const { importRunId, report } = await runApiImport(database, client, {
    projectSourceIds,
    dryRun,
    resumeFrom,
    allowMixedSources: flags.has("allow-mixed-sources"),
    onProgress: (step) => console.log(`  ${step}`),
    onStart: (startedId) => {
      startedRunId = startedId;
    },
  });
  console.log("");
  console.log(formatReport(report));
  console.log(`\nimport run ${importRunId}`);
} catch (error) {
  console.error(`\nImport failed: ${error.message}`);
  /*
    Only when a resume would actually do something. A dry run writes no cursor,
    and a reconciliation failure happens with every stage already checkpointed,
    so resuming it would skip everything and report success.
  */
  if (!dryRun && startedRunId !== undefined && error.resumable !== false) {
    console.error(`Resume it with: npm run migrate -- --resume ${startedRunId}`);
  } else if (error.resumable === false) {
    console.error("A resume cannot help here: every stage of that run is already");
    console.error("checkpointed. Fix the cause and run the import again.");
  }
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
