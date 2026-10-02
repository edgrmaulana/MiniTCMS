import { createCase, getDb, listCases } from "@/lib/db";
import {
  BadRequestError,
  customFrom,
  handle,
  listOptionsFrom,
  optionalInteger,
  optionalQueryId,
  optionalText,
  queryId,
  readBody,
  requireRole,
  requireText,
  requireUser,
} from "../helpers";

const WRITABLE = [
  "suiteId",
  "sectionId",
  "title",
  "templateId",
  "typeId",
  "priorityId",
  "refs",
  "estimate",
  "milestoneId",
  "custom",
] as const;

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const url = new URL(request.url);
    return Response.json(
      listCases(getDb(), queryId(url, "suiteId"), {
        ...listOptionsFrom(url),
        sectionId: optionalQueryId(url, "sectionId"),
        typeId: optionalQueryId(url, "typeId"),
        priorityId: optionalQueryId(url, "priorityId"),
      }),
    );
  });
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireRole("lead");
    const body = await readBody(request, WRITABLE);
    if (!Number.isInteger(body.suiteId)) throw new BadRequestError("suiteId is required");
    const id = createCase(getDb(), {
      suiteId: body.suiteId as number,
      sectionId: optionalInteger(body.sectionId, "sectionId"),
      title: requireText(body.title, "title"),
      templateId: optionalInteger(body.templateId, "templateId") ?? undefined,
      typeId: optionalInteger(body.typeId, "typeId"),
      priorityId: optionalInteger(body.priorityId, "priorityId"),
      refs: optionalText(body.refs, "refs"),
      estimate: optionalText(body.estimate, "estimate"),
      milestoneId: optionalInteger(body.milestoneId, "milestoneId"),
      custom: customFrom(body.custom),
      createdBy: user.userId,
    });
    return Response.json({ id }, { status: 201 });
  });
}
