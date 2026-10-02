import { getDb, getImportRun } from "@/lib/db";
import { NotFoundError } from "@/lib/db";
import { handle, requireRole, routeId } from "../../helpers";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    await requireRole("admin");
    const id = routeId((await params).id);
    const run = getImportRun(getDb(), id);
    if (!run) throw new NotFoundError(`No import run with id ${id}`);

    /*
      The report is stored as JSON text so SQLite never has to know its
      shape. It is parsed here rather than in the client so a half-written
      row from a crashed import reads as null instead of breaking the page.
    */
    return Response.json({
      ...run,
      cursor: undefined,
      report: parseJson(run.report),
      stepsCompleted: countSteps(run.cursor),
    });
  });
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function countSteps(cursor: string | null): number {
  const parsed = parseJson(cursor) as { done?: unknown } | null;
  return Array.isArray(parsed?.done) ? parsed.done.length : 0;
}
