import { addResultsBulk, getDb, type ResultInput } from "@/lib/db";
import {
  BadRequestError,
  customFrom,
  handle,
  optionalInteger,
  optionalText,
  readBody,
  requireUser,
} from "../helpers";

/*
  One route for one result and for a CI reporter's whole run, because it is
  one write either way - many results in one transaction rather than N round
  trips. There is deliberately no PATCH and no DELETE here: results are
  append-only and a correction is a new result.

  A reporter may post by test id or by case id. Case id is what a test file
  knows; the run it belongs to can be given once at the top level rather than
  repeated on every entry:

    { "runId": 12, "results": [{ "caseId": 1041, "statusId": 1 }] }

  Recording a result is tester work - that is the job - so this is the one
  write path that takes any session.
*/
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireUser();
    const body = await readBody(request, ["results", "runId"]);
    if (!Array.isArray(body.results) || body.results.length === 0) {
      throw new BadRequestError("results must be a non-empty array");
    }
    const runId = optionalInteger(body.runId, "runId") ?? undefined;
    const entries = body.results.map((entry, index) =>
      resultFrom(entry, index, user.userId, runId),
    );
    return Response.json({ recorded: addResultsBulk(getDb(), entries) }, { status: 201 });
  });
}

const RESULT_KEYS = [
  "testId",
  "caseId",
  "runId",
  "statusId",
  "comment",
  "elapsed",
  "defects",
  "version",
  "assignedTo",
  "custom",
] as const;

function resultFrom(
  value: unknown,
  index: number,
  createdBy: number,
  defaultRunId: number | undefined,
): ResultInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError(`results[${index}] must be an object`);
  }
  const entry = value as Record<string, unknown>;
  const unknown = Object.keys(entry).filter(
    (key) => !(RESULT_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new BadRequestError(`Unknown field in results[${index}]: ${unknown.join(", ")}`);
  }
  const testId = optionalInteger(entry.testId, `results[${index}].testId`) ?? undefined;
  const caseId = optionalInteger(entry.caseId, `results[${index}].caseId`) ?? undefined;
  const runId = optionalInteger(entry.runId, `results[${index}].runId`) ?? defaultRunId;
  /*
    Exactly one identity per entry, rejected here rather than resolved by
    precedence. Accepting both and preferring one means a reporter with a stale
    test id silently records against the wrong test.
  */
  if (testId !== undefined && caseId !== undefined) {
    throw new BadRequestError(`results[${index}] names testId or caseId, not both`);
  }
  if (testId === undefined && caseId === undefined) {
    throw new BadRequestError(`results[${index}] needs a testId, or a caseId and a runId`);
  }
  if (caseId !== undefined && runId === undefined) {
    throw new BadRequestError(`results[${index}] needs a runId to resolve caseId ${caseId}`);
  }
  if (!Number.isInteger(entry.statusId)) {
    throw new BadRequestError(`results[${index}].statusId is required`);
  }
  return {
    testId,
    caseId,
    runId: caseId === undefined ? undefined : runId,
    statusId: entry.statusId as number,
    comment: optionalText(entry.comment, "comment") ?? null,
    elapsed: optionalText(entry.elapsed, "elapsed") ?? null,
    defects: optionalText(entry.defects, "defects") ?? null,
    version: optionalText(entry.version, "version") ?? null,
    assignedTo: optionalInteger(entry.assignedTo, "assignedTo"),
    custom: customFrom(entry.custom),
    createdBy,
  };
}
