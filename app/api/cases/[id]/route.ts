import { deleteCase, getCase, getDb, updateCase } from "@/lib/db";
import {
  customFrom,
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

const PATCHABLE = [
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

export async function GET(_request: Request, context: Context): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const found = getCase(getDb(), routeId((await context.params).id));
    return found ? Response.json(found) : problem(404, "No such case");
  });
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return handle(async () => {
    const user = await requireUser();
    const id = routeId((await context.params).id);
    const body = await readBody(request, PATCHABLE);
    updateCase(
      getDb(),
      id,
      {
        sectionId: optionalInteger(body.sectionId, "sectionId"),
        title: body.title === undefined ? undefined : requireText(body.title, "title"),
        templateId: optionalInteger(body.templateId, "templateId") ?? undefined,
        typeId: optionalInteger(body.typeId, "typeId"),
        priorityId: optionalInteger(body.priorityId, "priorityId"),
        refs: optionalText(body.refs, "refs"),
        estimate: optionalText(body.estimate, "estimate"),
        milestoneId: optionalInteger(body.milestoneId, "milestoneId"),
        custom: customFrom(body.custom),
      },
      user.userId,
    );
    return Response.json(getCase(getDb(), id));
  });
}

// Soft delete. There is no hard delete route and there should not be one:
// tests.case_id points here and a run that happened stays true.
export async function DELETE(_request: Request, context: Context): Promise<Response> {
  return handle(async () => {
    const user = await requireUser();
    deleteCase(getDb(), routeId((await context.params).id), user.userId);
    return Response.json({ ok: true });
  });
}
