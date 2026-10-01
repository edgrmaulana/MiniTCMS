import { getDb, getSuite, updateSuite } from "@/lib/db";
import {
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
    const suite = getSuite(getDb(), routeId((await context.params).id));
    return suite ? Response.json(suite) : problem(404, "No such suite");
  });
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const id = routeId((await context.params).id);
    const body = await readBody(request, ["name", "description"]);
    updateSuite(getDb(), id, {
      name: body.name === undefined ? undefined : requireText(body.name, "name"),
      description: optionalText(body.description, "description"),
    });
    return Response.json(getSuite(getDb(), id));
  });
}
