import { createSuite, getDb, listSuites } from "@/lib/db";
import {
  BadRequestError,
  handle,
  listOptionsFrom,
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
    return Response.json(listSuites(getDb(), queryId(url, "projectId"), listOptionsFrom(url)));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    await requireRole("lead");
    const body = await readBody(request, ["projectId", "name", "description"]);
    if (!Number.isInteger(body.projectId)) {
      throw new BadRequestError("projectId is required");
    }
    const id = createSuite(getDb(), {
      projectId: body.projectId as number,
      name: requireText(body.name, "name"),
      description: optionalText(body.description, "description") ?? null,
    });
    return Response.json({ id }, { status: 201 });
  });
}
