import { createMilestone, getDb, listMilestones } from "@/lib/db";
import {
  BadRequestError,
  handle,
  listOptionsFrom,
  optionalInteger,
  optionalText,
  queryId,
  readBody,
  requireText,
  requireUser,
} from "../helpers";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const url = new URL(request.url);
    return Response.json(listMilestones(getDb(), queryId(url, "projectId"), listOptionsFrom(url)));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const body = await readBody(request, [
      "projectId",
      "parentId",
      "name",
      "description",
      "dueOn",
      "startedOn",
    ]);
    if (!Number.isInteger(body.projectId)) throw new BadRequestError("projectId is required");
    const id = createMilestone(getDb(), {
      projectId: body.projectId as number,
      parentId: optionalInteger(body.parentId, "parentId") ?? null,
      name: requireText(body.name, "name"),
      description: optionalText(body.description, "description") ?? null,
      dueOn: optionalInteger(body.dueOn, "dueOn") ?? null,
      startedOn: optionalInteger(body.startedOn, "startedOn") ?? null,
    });
    return Response.json({ id }, { status: 201 });
  });
}
