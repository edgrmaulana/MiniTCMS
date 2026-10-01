import { AttachmentTooLargeError, maxAttachmentBytes, saveAttachment } from "@/lib/attachments";
import { ATTACHMENT_ENTITIES, type AttachmentEntity } from "@/lib/format";
import { BadRequestError, handle, requireUser } from "../helpers";

/*
  The one route that does not take JSON - a file upload is multipart or it is
  a base64 blob in a JSON body, and the second is 33% bigger for no gain.
  Everything else about it is the same: session first, validate, delegate.
*/
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    await requireUser();
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      throw new BadRequestError("Content-Type must be multipart/form-data");
    }

    /*
      Checked before formData(), which buffers the entire body. Left until
      after, the cap still returns 413 but only once the whole upload is in
      memory - a 40MB request against a 32MB limit was being read in full
      before being refused. The declared length can lie; the real cap in
      saveAttachment still applies, and this is what stops the obvious case
      from costing anything.
    */
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxAttachmentBytes()) {
      throw new AttachmentTooLargeError(
        `That request is ${declaredLength} bytes; the limit is ${maxAttachmentBytes()}`,
      );
    }

    const form = await request.formData();
    const entityType = String(form.get("entityType") ?? "");
    if (!(ATTACHMENT_ENTITIES as readonly string[]).includes(entityType)) {
      throw new BadRequestError(`entityType must be one of ${ATTACHMENT_ENTITIES.join(", ")}`);
    }
    const entityId = Number(form.get("entityId"));
    if (!Number.isInteger(entityId) || entityId < 1) {
      throw new BadRequestError("entityId is required");
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new BadRequestError("file is required");
    }

    const id = await saveAttachment(entityType as AttachmentEntity, entityId, {
      name: file.name,
      type: file.type || null,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return Response.json({ id }, { status: 201 });
  });
}
