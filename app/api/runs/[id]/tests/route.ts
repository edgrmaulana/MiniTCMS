import { getDb, listTests } from "@/lib/db";
import {
  handle,
  idListParam,
  listOptionsFrom,
  optionalQueryId,
  requireUser,
  routeId,
} from "../../../helpers";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requireUser();
    const url = new URL(request.url);
    return Response.json(
      listTests(getDb(), routeId((await context.params).id), {
        ...listOptionsFrom(url),
        statusIds: idListParam(url, "status"),
        assignedTo: optionalQueryId(url, "assignedTo"),
      }),
    );
  });
}
