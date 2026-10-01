import { getDb, getTest, listResults } from "@/lib/db";
import { handle, listOptionsFrom, problem, requireUser, routeId } from "../../../helpers";

// A test's results are its change log, newest first. There is no separate
// audit table and there does not need to be one.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requireUser();
    const id = routeId((await context.params).id);
    const database = getDb();
    if (!getTest(database, id)) return problem(404, "No such test");
    return Response.json(listResults(database, id, listOptionsFrom(new URL(request.url))));
  });
}
