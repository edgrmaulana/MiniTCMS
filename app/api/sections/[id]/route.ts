import { editSection, getDb } from "@/lib/db";
import {
  handle,
  optionalInteger,
  optionalText,
  readBody,
  requireText,
  requireUser,
  routeId,
} from "../../helpers";

/*
  Rename and move are one PATCH because they are one user action often enough
  ("drag it over there and call it something else") that splitting them would
  mean two requests and a half-applied state between them. `parentId` present
  means move, absent means leave the tree alone. editSection runs both in one
  transaction, so a rejected move takes the rename back with it.
*/
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const id = routeId((await context.params).id);
    const body = await readBody(request, ["name", "description", "parentId", "displayOrder"]);
    editSection(getDb(), id, {
      name: body.name === undefined ? undefined : requireText(body.name, "name"),
      description: optionalText(body.description, "description"),
      parentId: body.parentId === undefined ? undefined : optionalInteger(body.parentId, "parentId") ?? null,
      displayOrder: optionalInteger(body.displayOrder, "displayOrder") ?? undefined,
    });
    return Response.json({ ok: true });
  });
}
