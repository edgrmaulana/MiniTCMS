import { createSection, getDb } from "@/lib/db";
import {
  BadRequestError,
  handle,
  optionalInteger,
  optionalText,
  readBody,
  requireRole,
  requireText,
} from "../helpers";

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    await requireRole("lead");
    const body = await readBody(request, ["suiteId", "parentId", "name", "description"]);
    if (!Number.isInteger(body.suiteId)) throw new BadRequestError("suiteId is required");
    const id = createSection(getDb(), {
      suiteId: body.suiteId as number,
      parentId: optionalInteger(body.parentId, "parentId") ?? null,
      name: requireText(body.name, "name"),
      description: optionalText(body.description, "description") ?? null,
    });
    return Response.json({ id }, { status: 201 });
  });
}
