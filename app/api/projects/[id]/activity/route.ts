import { getDb, getProject, recentActivity } from "@/lib/db";
import { handle, problem, requireUser, routeId } from "../../../helpers";

// Recent activity is recent results: the dashboard feed. The row count is
// bounded inside lib/db.ts, so an absurd ?limit= is a short list, not a scan.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requireUser();
    const url = new URL(request.url);
    const database = getDb();
    const projectId = routeId((await context.params).id);
    // An id nothing exists for answers 404 here as it does on the project
    // itself. Without this a mistyped id reads as "this project has no
    // results", which is a different and wrong fact.
    if (!getProject(database, projectId)) return problem(404, "No such project");
    return Response.json({
      rows: recentActivity(database, projectId, Number(url.searchParams.get("limit") ?? 10)),
    });
  });
}
