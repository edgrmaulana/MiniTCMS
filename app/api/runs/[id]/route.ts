import {
  countRunResults,
  deleteRunWithCount,
  editRun,
  getDb,
  getRun,
  listStatuses,
  runSummary,
} from "@/lib/db";
import { runProgress } from "@/lib/format";
import {
  BadRequestError,
  handle,
  optionalText,
  problem,
  readBody,
  requireRole,
  requireText,
  requireUser,
  routeId,
} from "../../helpers";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const id = routeId((await context.params).id);
    const database = getDb();
    const run = getRun(database, id);
    if (!run) return problem(404, "No such run");
    /*
      The result count is asked for, never included by default. It counts every
      result in the run - measured at 5.3ms against 50,000 tests versus 1.5ms
      for the summary alone - and the run screen re-reads this route after every
      status keystroke. The only caller that needs the number is the delete
      confirmation, which asks once, on the click.
    */
    const wantsResultCount = new URL(request.url).searchParams.get("resultCount") === "true";
    return Response.json({
      ...run,
      progress: runProgress(runSummary(database, id), listStatuses(database)),
      resultCount: wantsResultCount ? countRunResults(database, id) : null,
    });
  });
}

// Close and reopen come through here. Closing is a lock: lib/db.ts refuses
// every result write against a closed run, so a CI reporter gets the same
// answer as the UI.
export async function PATCH(request: Request, context: Context): Promise<Response> {
  return handle(async () => {
    // Renaming, closing and reopening are all lead work, checked before the
    // body is read. A tester records results inside a run; they do not decide
    // when it is finished.
    await requireRole("lead");
    const id = routeId((await context.params).id);
    const body = await readBody(request, ["name", "description", "config", "isCompleted"]);
    if (body.isCompleted !== undefined && typeof body.isCompleted !== "boolean") {
      throw new BadRequestError("isCompleted must be true or false");
    }

    const database = getDb();
    // One PATCH, one transaction: a rejected rename must not leave the run
    // closed when the caller believes it is still open.
    editRun(database, id, {
      name: body.name === undefined ? undefined : requireText(body.name, "name"),
      description: optionalText(body.description, "description"),
      config: optionalText(body.config, "config"),
      isCompleted: body.isCompleted as boolean | undefined,
    });
    return Response.json(getRun(database, id));
  });
}

/*
  The one genuinely destructive path in the product: this takes the run's
  tests and every result ever recorded against them. Admin only, and the
  response carries the count that was destroyed so the UI can say so rather
  than claim a vague success.
*/
export async function DELETE(_request: Request, context: Context): Promise<Response> {
  return handle(async () => {
    await requireRole("admin");
    const id = routeId((await context.params).id);
    // Counted and deleted in one transaction, so the number the UI shows a
    // human is the number that was actually destroyed.
    return Response.json({
      ok: true,
      resultsDeleted: deleteRunWithCount(getDb(), id),
    });
  });
}
