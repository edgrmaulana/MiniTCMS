import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { getDb, insertAttachment } from "./db.ts";
import type { AttachmentEntity } from "./format.ts";

/*
  One storage function behind one interface, so an S3 body can replace this
  one later. One implementation only - no factory, no driver registry, until
  a second backend actually exists.
*/

export const DEFAULT_MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

export class AttachmentTooLargeError extends Error {}

export function attachmentsDir(): string {
  return process.env.ATTACHMENTS_DIR ?? "./data/attachments";
}

export function maxAttachmentBytes(): number {
  const configured = Number(process.env.MAX_ATTACHMENT_BYTES);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_ATTACHMENT_BYTES;
}

/*
  The stored name is generated, never derived from what the uploader sent.
  Sanitising a filename means being right about every traversal trick in
  every encoding; generating one means the question never arises. The name
  the user chose is kept in the database column and used only when serving.
*/
export function storageNameFor(filename: string): string {
  const extension = extname(filename).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : "";
  return `${randomBytes(16).toString("hex")}${safeExtension}`;
}

export async function saveAttachment(
  entityType: AttachmentEntity,
  entityId: number,
  file: { name: string; type: string | null; bytes: Uint8Array },
): Promise<number> {
  if (file.bytes.byteLength > maxAttachmentBytes()) {
    throw new AttachmentTooLargeError(
      `That file is ${file.bytes.byteLength} bytes; the limit is ${maxAttachmentBytes()}`,
    );
  }
  const directory = attachmentsDir();
  await mkdir(directory, { recursive: true });

  const storageName = storageNameFor(file.name);
  await writeFile(join(directory, storageName), file.bytes, { flag: "wx" });

  return insertAttachment(getDb(), {
    entityType,
    entityId,
    filename: file.name,
    mime: file.type,
    size: file.bytes.byteLength,
    storagePath: storageName,
  });
}
