import { maxAttachmentBytes } from "@/lib/attachments";
import { AttachmentTooLargeError } from "@/lib/attachments";
import { getDb } from "@/lib/db";
import { runCsvImport } from "@/lib/migrate/import-csv";
import { DATE_ORDERS, isDateOrder, isValidTimeZone, parseUserMap } from "@/lib/migrate/map";
import { BadRequestError, handle, requireRole, routeId } from "../../helpers";

/*
  The CSV entry point. Multipart, because the alternative is a base64 blob in
  a JSON body for a third more bytes.

  The import runs inside the request rather than in the background, which
  is the honest shape for this one: a 243-case export takes 69ms and the
  upload cap bounds the worst case at roughly a minute. The API path is the
  one that takes hours, and that is a CLI job, not a route.

  Everything the file cannot say is a required field, not a default:
  `project`, because no column holds it; `timeZone` and `dateOrder`, because
  "1/2/2026" is two different dates and nothing in the export says which
  (plan section 6.2). The route refuses rather than guessing.
*/
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    await requireRole("admin", "lead");

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      throw new BadRequestError("Content-Type must be multipart/form-data");
    }
    // Checked before formData(), which buffers the whole body.
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxAttachmentBytes()) {
      throw new AttachmentTooLargeError(
        `That request is ${declaredLength} bytes; the limit is ${maxAttachmentBytes()}`,
      );
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new BadRequestError("file is required");
    }
    if (file.size > maxAttachmentBytes()) {
      throw new AttachmentTooLargeError(
        `That file is ${file.size} bytes; the limit is ${maxAttachmentBytes()}`,
      );
    }

    const projectId = routeId(String(form.get("projectId") ?? ""));

    const timeZone = String(form.get("timeZone") ?? "");
    if (!isValidTimeZone(timeZone)) {
      throw new BadRequestError(
        `timeZone must be an IANA zone name such as Asia/Jakarta: the export's ` +
          `timestamps carry no offset`,
      );
    }
    const dateOrder = String(form.get("dateOrder") ?? "");
    if (!isDateOrder(dateOrder)) {
      throw new BadRequestError(`dateOrder must be one of ${DATE_ORDERS.join(", ")}`);
    }

    const userMapField = form.get("users");
    const userMap = userMapField ? parseUserMap(String(userMapField)) : undefined;

    const { importRunId, report } = runCsvImport(getDb(), await file.text(), {
      projectId,
      timeZone,
      dateOrder,
      userMap,
      dryRun: form.get("dryRun") === "true",
      allowMixedSources: form.get("allowMixedSources") === "true",
    });
    return Response.json({ importRunId, report }, { status: 201 });
  });
}
