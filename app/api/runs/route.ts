import { createRun, getDb, listRunsWithProgress } from "@/lib/db";
import {
  BadRequestError,
  handle,
  listOptionsFrom,
  optionalFlag,
  optionalInteger,
  optionalQueryId,
  optionalText,
  queryId,
  readBody,
  requireIdList,
  requireText,
  requireUser,
} from "../helpers";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const url = new URL(request.url);
    return Response.json(
      // With progress: the list screen draws a bar per run, and one summary
      // request per row would be 25 round trips for one screen.
      listRunsWithProgress(getDb(), {
        ...listOptionsFrom(url),
        projectId: queryId(url, "projectId"),
        planId: optionalQueryId(url, "planId"),
        isCompleted: optionalFlag(url, "isCompleted"),
      }),
    );
  });
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const body = await readBody(request, [
      "projectId",
      "suiteId",
      "name",
      "description",
      "config",
      "planId",
      "milestoneId",
      "includeAll",
      "caseIds",
      "assignedTo",
    ]);
    if (!Number.isInteger(body.projectId)) throw new BadRequestError("projectId is required");
    if (!Number.isInteger(body.suiteId)) throw new BadRequestError("suiteId is required");
    if (body.includeAll !== undefined && typeof body.includeAll !== "boolean") {
      throw new BadRequestError("includeAll must be true or false");
    }
    const id = createRun(getDb(), {
      projectId: body.projectId as number,
      suiteId: body.suiteId as number,
      name: requireText(body.name, "name"),
      description: optionalText(body.description, "description") ?? null,
      config: optionalText(body.config, "config") ?? null,
      planId: optionalInteger(body.planId, "planId") ?? null,
      milestoneId: optionalInteger(body.milestoneId, "milestoneId") ?? null,
      includeAll: body.includeAll as boolean | undefined,
      caseIds: body.caseIds === undefined ? undefined : requireIdList(body.caseIds, "caseIds"),
      assignedTo: optionalInteger(body.assignedTo, "assignedTo") ?? null,
    });
    return Response.json({ id }, { status: 201 });
  });
}
