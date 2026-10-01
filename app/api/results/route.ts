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
*/
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireUser();
    const body = await readBody(request, ["results"]);
    if (!Array.isArray(body.results) || body.results.length === 0) {
      throw new BadRequestError("results must be a non-empty array");
    }
    const entries = body.results.map((entry, index) => resultFrom(entry, index, user.userId));
    return Response.json({ recorded: addResultsBulk(getDb(), entries) }, { status: 201 });
  });
}

const RESULT_KEYS = [
  "testId",
  "statusId",
  "comment",
  "elapsed",
  "defects",
  "version",
  "assignedTo",
  "custom",
] as const;

function resultFrom(value: unknown, index: number, createdBy: number): ResultInput {
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
  if (!Number.isInteger(entry.testId)) throw new BadRequestError(`results[${index}].testId is required`);
  if (!Number.isInteger(entry.statusId)) {
    throw new BadRequestError(`results[${index}].statusId is required`);
  }
  return {
    testId: entry.testId as number,
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
