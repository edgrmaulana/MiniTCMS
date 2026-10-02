import { getDb, getProject, projectOverview, updateProject } from "@/lib/db";
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
    const database = getDb();
    const id = routeId((await context.params).id);
    const project = getProject(database, id);
    if (!project) return problem(404, "No such project");
    // The dashboard's numbers ride along: it needs the name and the rollup in
    // the same breath, and both come from one project id.
    return Response.json({ ...project, overview: projectOverview(database, id) });
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
