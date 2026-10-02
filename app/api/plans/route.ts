import { createPlan, getDb, listPlans } from "@/lib/db";
import {
  BadRequestError,
  handle,
  listOptionsFrom,
  optionalInteger,
  optionalText,
  queryId,
  readBody,
  requireRole,
  requireText,
  requireUser,
} from "../helpers";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const url = new URL(request.url);
    return Response.json(listPlans(getDb(), queryId(url, "projectId"), listOptionsFrom(url)));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    await requireRole("lead");
    const body = await readBody(request, ["projectId", "name", "description", "milestoneId"]);
    if (!Number.isInteger(body.projectId)) throw new BadRequestError("projectId is required");
    const id = createPlan(getDb(), {
      projectId: body.projectId as number,
      name: requireText(body.name, "name"),
      description: optionalText(body.description, "description") ?? null,
      milestoneId: optionalInteger(body.milestoneId, "milestoneId") ?? null,
    });
    return Response.json({ id }, { status: 201 });
  });
}
