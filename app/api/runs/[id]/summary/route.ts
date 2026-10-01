import { getDb, listStatuses, runSummary } from "@/lib/db";
import { runProgress } from "@/lib/format";
import { handle, requireUser, routeId } from "../../../helpers";

// One GROUP BY, never a fetch-and-count. The pass rate comes back with its
// untested count attached so no caller can render the percentage alone.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requireUser();
    const database = getDb();
    const id = routeId((await context.params).id);
    return Response.json(runProgress(runSummary(database, id), listStatuses(database)));
  });
}
