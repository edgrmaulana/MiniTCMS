import { getDb, setStatusBulk } from "@/lib/db";
import {
  BadRequestError,
  handle,
  optionalText,
  readBody,
  requireIdList,
  requireUser,
  routeId,
} from "../../../../helpers";

// "Select forty rows, mark them all blocked." Every id gets its own result
// row; this is the same write as a single result, batched.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await requireUser();
    const runId = routeId((await context.params).id);
    const body = await readBody(request, ["testIds", "statusId", "comment"]);
    if (!Number.isInteger(body.statusId)) throw new BadRequestError("statusId is required");
    const recorded = setStatusBulk(
      getDb(),
      requireIdList(body.testIds, "testIds"),
      body.statusId as number,
      {
        comment: optionalText(body.comment, "comment") ?? null,
        createdBy: user.userId,
        // The run in the path is checked, not decorative: a test from
        // another run in the body is a 409, not a silent write over there.
        runId,
      },
    );
    return Response.json({ recorded });
  });
}
