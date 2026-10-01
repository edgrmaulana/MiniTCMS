import { getDb, getMilestone, milestoneSummary, updateMilestone } from "@/lib/db";
import { runProgress } from "@/lib/format";
import { listStatuses } from "@/lib/db";
import {
  BadRequestError,
  handle,
  optionalInteger,
  optionalText,
  problem,
  readBody,
  requireText,
  requireUser,
  routeId,
} from "../../helpers";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const id = routeId((await context.params).id);
    const database = getDb();
    const milestone = getMilestone(database, id);
    if (!milestone) return problem(404, "No such milestone");
    return Response.json({
      ...milestone,
      progress: runProgress(milestoneSummary(database, id), listStatuses(database)),
    });
  });
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const id = routeId((await context.params).id);
    const body = await readBody(request, [
      "name",
      "description",
      "dueOn",
      "startedOn",
      "isCompleted",
    ]);
    if (body.isCompleted !== undefined && typeof body.isCompleted !== "boolean") {
      throw new BadRequestError("isCompleted must be true or false");
    }
    updateMilestone(getDb(), id, {
      name: body.name === undefined ? undefined : requireText(body.name, "name"),
      description: optionalText(body.description, "description"),
      dueOn: optionalInteger(body.dueOn, "dueOn"),
      startedOn: optionalInteger(body.startedOn, "startedOn"),
      isCompleted: body.isCompleted as boolean | undefined,
    });
    return Response.json(getMilestone(getDb(), id));
  });
}
