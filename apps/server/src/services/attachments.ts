/**
 * Attachments (receipts, bill PDFs, logos). Blobs live in the configured store; rows and links in
 * the org database. Served with `Content-Disposition: attachment` unless they are raster images or
 * PDFs (SPEC §12), and never executed.
 */

import { sha256Hex } from "@cosimo/core";
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { and, desc, eq } from "drizzle-orm";
import { notFound, unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import type { BlobStore } from "./storage.ts";

type Reader = OrgDb | OrgTx;

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_TARGETS = [
  "bill",
  "invoice",
  "journal_entry",
  "bank_transaction",
  "contact",
  "org_settings",
  "receipt",
] as const;
export type AttachmentTarget = (typeof ATTACHMENT_TARGETS)[number];

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

/** Identify the real type from magic bytes; anything unrecognized is treated as opaque binary. */
export function sniffType(bytes: Uint8Array, declared: string): string {
  const b = bytes;
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return "image/webp";
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0);
    if (/^hei|^mif1|^heix/.test(brand)) return "image/heic";
  }
  if (declared === "text/csv" || declared === "text/plain") return declared;
  return "application/octet-stream";
}

export function dispositionFor(mime: string, filename: string) {
  const safe = filename.replace(/[^\w.\- ]+/g, "_").slice(0, 150) || "file";
  const kind = INLINE_TYPES.has(mime) ? "inline" : "attachment";
  return `${kind}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename.slice(0, 150))}`;
}

export function attachmentView(a: typeof org.attachments.$inferSelect) {
  return {
    id: a.id,
    filename: a.filename,
    mime_type: a.mimeType,
    size_bytes: a.sizeBytes,
    sha256: a.sha256,
    uploaded_by: a.uploadedBy,
    created_at: a.createdAt,
  };
}

/** Store the blob (outside the DB transaction), then record it. */
export async function storeBlob(
  store: BlobStore,
  orgId: string,
  file: { filename: string; type: string; bytes: Uint8Array },
) {
  if (file.bytes.byteLength === 0) throw unprocessable("The file is empty.", "empty_file");
  if (file.bytes.byteLength > MAX_ATTACHMENT_BYTES)
    throw unprocessable("Files are limited to 20 MB.", "too_large");
  const mime = sniffType(file.bytes, file.type);
  const id = newId();
  const key = `${orgId}/${id}`;
  await store.put(key, file.bytes, mime);
  return {
    id,
    key,
    mime,
    sha256: sha256Hex(file.bytes),
    size: file.bytes.byteLength,
    filename: file.filename.slice(0, 255) || "file",
  };
}

export async function recordAttachmentTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  blob: Awaited<ReturnType<typeof storeBlob>>,
  target?: { type: AttachmentTarget; id: string } | null,
) {
  await tx.insert(org.attachments).values({
    id: blob.id,
    storageKey: blob.key,
    filename: blob.filename,
    mimeType: blob.mime,
    sizeBytes: blob.size,
    sha256: blob.sha256,
    uploadedBy: a.userId,
  });
  if (target)
    await tx
      .insert(org.attachmentLinks)
      .values({ attachmentId: blob.id, targetType: target.type, targetId: target.id });
  await appendAudit(tx, orgId, a, {
    action: "attachment.upload",
    targetType: "attachment",
    targetId: blob.id,
    after: {
      filename: blob.filename,
      mime_type: blob.mime,
      size_bytes: blob.size,
      sha256: blob.sha256,
      target: target ?? null,
    },
  });
  return (await tx.select().from(org.attachments).where(eq(org.attachments.id, blob.id)).get())!;
}

export async function mustGetAttachment(db: Reader, id: string) {
  const a = await db.select().from(org.attachments).where(eq(org.attachments.id, id)).get();
  if (!a) throw notFound("Attachment");
  return a;
}

export async function listAttachments(db: Reader, target: { type: string; id: string }) {
  const rows = await db
    .select({ a: org.attachments })
    .from(org.attachmentLinks)
    .innerJoin(org.attachments, eq(org.attachments.id, org.attachmentLinks.attachmentId))
    .where(and(eq(org.attachmentLinks.targetType, target.type), eq(org.attachmentLinks.targetId, target.id)))
    .orderBy(desc(org.attachments.createdAt))
    .all();
  return rows.map((r) => attachmentView(r.a));
}

export async function linkAttachmentTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  target: { type: AttachmentTarget; id: string },
) {
  await mustGetAttachment(tx, id);
  await tx
    .insert(org.attachmentLinks)
    .values({ attachmentId: id, targetType: target.type, targetId: target.id })
    .onConflictDoNothing();
  await appendAudit(tx, orgId, a, {
    action: "attachment.link",
    targetType: "attachment",
    targetId: id,
    after: target,
  });
}

export async function unlinkAttachmentTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  target: { type: string; id: string },
) {
  await tx
    .delete(org.attachmentLinks)
    .where(
      and(
        eq(org.attachmentLinks.attachmentId, id),
        eq(org.attachmentLinks.targetType, target.type),
        eq(org.attachmentLinks.targetId, target.id),
      ),
    );
  await appendAudit(tx, orgId, a, {
    action: "attachment.unlink",
    targetType: "attachment",
    targetId: id,
    before: target,
  });
}
