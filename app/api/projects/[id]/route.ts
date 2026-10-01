import { getDb, getProject, updateProject } from "@/lib/db";
import {
  BadRequestError,
  handle,
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
    const project = getProject(getDb(), routeId((await context.params).id));
    return project ? Response.json(project) : problem(404, "No such project");
  });
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const id = routeId((await context.params).id);
    const body = await readBody(request, ["name", "announcement", "isCompleted"]);
    if (body.isCompleted !== undefined && typeof body.isCompleted !== "boolean") {
      throw new BadRequestError("isCompleted must be true or false");
    }
    updateProject(getDb(), id, {
      name: body.name === undefined ? undefined : requireText(body.name, "name"),
      announcement: optionalText(body.announcement, "announcement"),
      isCompleted: body.isCompleted as boolean | undefined,
    });
    return Response.json(getProject(getDb(), id));
  });
}
