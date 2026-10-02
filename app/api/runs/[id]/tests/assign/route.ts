import { assignTests, getDb } from "@/lib/db";
import {
  handle,
  optionalInteger,
  readBody,
  requireIdList,
  requireRole,
  routeId,
} from "../../../../helpers";

// Assignment is a work queue, not a lock: this changes who a test is waiting
// on, never who is allowed to record against it. A null assignee unassigns.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    await requireRole("lead");
    const runId = routeId((await context.params).id);
    const body = await readBody(request, ["testIds", "assignedTo"]);
    const changed = assignTests(
      getDb(),
      requireIdList(body.testIds, "testIds"),
      optionalInteger(body.assignedTo, "assignedTo") ?? null,
      runId,
    );
    return Response.json({ changed });
  });
}
