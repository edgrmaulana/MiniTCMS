import { getDb, sectionTree } from "@/lib/db";
import { handle, requireUser, routeId } from "../../../helpers";

// The whole tree in one call, from one recursive CTE. A fetch per level is
// what this route exists to prevent.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requireUser();
    return Response.json({ rows: sectionTree(getDb(), routeId((await context.params).id)) });
  });
}
