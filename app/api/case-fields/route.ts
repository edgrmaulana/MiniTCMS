import { getDb, listCaseFields, upsertCaseField } from "@/lib/db";
import { CASE_FIELD_TYPES, isCaseFieldType } from "@/lib/format";
import {
  BadRequestError,
  handle,
  readBody,
  requireText,
  requireUser,
} from "../helpers";

export async function GET(): Promise<Response> {
  return handle(async () => {
    await requireUser();
    return Response.json({ rows: listCaseFields(getDb()) });
  });
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const body = await readBody(request, ["systemName", "label", "type", "isGlobal", "configs"]);
    const type = requireText(body.type, "type");
    // A type the UI cannot render is refused here, where a human typed it.
    // The import is the one path allowed to keep an unknown type, because
    // there the alternative is losing the field.
    if (!isCaseFieldType(type)) {
      throw new BadRequestError(`type must be one of ${CASE_FIELD_TYPES.join(", ")}`);
    }
    if (body.configs !== undefined && typeof body.configs !== "string") {
      throw new BadRequestError("configs must be a JSON string");
    }
    const { id } = upsertCaseField(getDb(), {
      systemName: requireText(body.systemName, "systemName"),
      label: requireText(body.label, "label"),
      type,
      isGlobal: body.isGlobal === undefined ? true : body.isGlobal === true,
      configs: (body.configs as string | undefined) ?? null,
    });
    return Response.json({ id }, { status: 201 });
  });
}
