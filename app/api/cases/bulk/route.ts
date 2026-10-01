import { bulkMoveCases, bulkUpdateCases, getDb } from "@/lib/db";
import {
  BadRequestError,
  handle,
  optionalInteger,
  readBody,
  requireIdList,
  requireUser,
} from "../../helpers";

/*
  One route for both because the UI sends one request after a multi-select:
  move these, or change a field on these. Chunking at 500 happens in
  lib/db.ts - the caller is allowed to send the whole selection.
*/
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireUser();
    const body = await readBody(request, [
      "caseIds",
      "sectionId",
      "typeId",
      "priorityId",
      "milestoneId",
    ]);
    const caseIds = requireIdList(body.caseIds, "caseIds");
    const database = getDb();

    if (body.sectionId !== undefined) {
      const sectionId = optionalInteger(body.sectionId, "sectionId");
      if (typeof sectionId !== "number") {
        throw new BadRequestError("sectionId cannot be null in a bulk move");
      }
      return Response.json({ changed: bulkMoveCases(database, caseIds, sectionId, user.userId) });
    }

    if (body.typeId === undefined && body.priorityId === undefined && body.milestoneId === undefined) {
      throw new BadRequestError("Nothing to change");
    }
    const changed = bulkUpdateCases(
      database,
      caseIds,
      {
        typeId: optionalInteger(body.typeId, "typeId"),
        priorityId: optionalInteger(body.priorityId, "priorityId"),
        milestoneId: optionalInteger(body.milestoneId, "milestoneId"),
      },
      user.userId,
    );
    return Response.json({ changed });
  });
}
