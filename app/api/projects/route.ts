import { createProject, getDb, listProjects } from "@/lib/db";
import { SUITE_MODE, type SuiteMode } from "@/lib/format";
import {
  BadRequestError,
  handle,
  listOptionsFrom,
  optionalText,
  readBody,
  requireRole,
  requireText,
  requireUser,
} from "../helpers";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const url = new URL(request.url);
    return Response.json(listProjects(getDb(), listOptionsFrom(url)));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    await requireRole("lead");
    const body = await readBody(request, ["name", "announcement", "suiteMode"]);
    const suiteMode = body.suiteMode ?? SUITE_MODE.single;
    if (!Object.values(SUITE_MODE).includes(suiteMode as SuiteMode)) {
      throw new BadRequestError(`suiteMode must be one of ${Object.values(SUITE_MODE).join(", ")}`);
    }
    const id = createProject(getDb(), {
      name: requireText(body.name, "name"),
      announcement: optionalText(body.announcement, "announcement") ?? null,
      suiteMode: suiteMode as SuiteMode,
    });
    return Response.json({ id }, { status: 201 });
  });
}
