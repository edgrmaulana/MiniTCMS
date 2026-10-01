import { getDb, getPlan, listStatuses, planSummary, updatePlan } from "@/lib/db";
import { runProgress } from "@/lib/format";
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
    const plan = getPlan(database, id);
    if (!plan) return problem(404, "No such plan");
    return Response.json({
      ...plan,
      progress: runProgress(planSummary(database, id), listStatuses(database)),
    });
  });
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const id = routeId((await context.params).id);
    const body = await readBody(request, ["name", "description", "milestoneId", "isCompleted"]);
    if (body.isCompleted !== undefined && typeof body.isCompleted !== "boolean") {
      throw new BadRequestError("isCompleted must be true or false");
    }
    updatePlan(getDb(), id, {
      name: body.name === undefined ? undefined : requireText(body.name, "name"),
      description: optionalText(body.description, "description"),
      milestoneId: optionalInteger(body.milestoneId, "milestoneId"),
      isCompleted: body.isCompleted as boolean | undefined,
    });
    return Response.json(getPlan(getDb(), id));
  });
}
