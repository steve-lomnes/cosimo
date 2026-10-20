/**
 * Bank file import (SPEC §7.2): CSV (with a saved per-account column mapping), OFX, and QFX.
 * Idempotent: every row carries a dedupe hash (and OFX rows their FITID), so importing the same
 * file twice creates no new rows.
 */
import {
  applyProfile,
  type CsvProfile,
  dedupeHashes,
  detectFormat,
  guessProfile,
  normalizeDescription,
  type ParseResult,
  parseOfx,
  sha256Hex,
} from "@cosimo/core";
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { unprocessable } from "../http/errors.ts";
import { type ActorInfo, systemActor } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { applyRulesTx, mustGetBankAccount, pairImportedTransfersTx } from "./banking.ts";

type Reader = OrgDb | OrgTx;

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export interface ImportFile {
  filename: string;
  content: string;
  /** CSV only: overrides the saved or guessed column mapping. */
  profile?: CsvProfile | null;
}

export async function savedProfile(db: Reader, bankAccountId: string): Promise<CsvProfile | null> {
  const row = await db
    .select()
    .from(org.csvProfiles)
    .where(eq(org.csvProfiles.bankAccountId, bankAccountId))
    .get();
  if (!row) return null;
  const extra = JSON.parse(row.columnMapJson) as Omit<
    CsvProfile,
    "dateFormat" | "amountMode" | "signConvention" | "skipRows"
  >;
  return {
    ...extra,
    dateFormat: row.dateFormat as CsvProfile["dateFormat"],
    amountMode: row.amountMode,
    signConvention: row.signConvention,
    skipRows: row.skipRows,
  };
}

async function saveProfileTx(tx: OrgTx, bankAccountId: string, p: CsvProfile) {
  const { dateFormat, amountMode, signConvention, skipRows, ...rest } = p;
  const values = {
    columnMapJson: JSON.stringify(rest),
    dateFormat,
    amountMode,
    signConvention,
    skipRows,
  };
  const existing = await tx
    .select({ id: org.csvProfiles.id })
    .from(org.csvProfiles)
    .where(eq(org.csvProfiles.bankAccountId, bankAccountId))
    .get();
  if (existing) await tx.update(org.csvProfiles).set(values).where(eq(org.csvProfiles.id, existing.id));
  else await tx.insert(org.csvProfiles).values({ id: newId(), bankAccountId, ...values });
}

interface Parsed {
  format: "csv" | "ofx" | "qfx";
  result: ParseResult;
  profile: CsvProfile | null;
  headers: string[];
  preview: string[][];
  profileSource: "given" | "saved" | "guessed" | null;
}

async function parseFile(db: Reader, bankAccountId: string, f: ImportFile): Promise<Parsed> {
  if (f.content.length > MAX_IMPORT_BYTES)
    throw unprocessable("The file is larger than 10 MB. Split it and import the parts.", "too_large");
  if (!f.content.trim()) throw unprocessable("The file is empty.", "empty_file");
  const format = detectFormat(f.filename, f.content);
  if (format !== "csv") {
    return {
      format,
      result: parseOfx(f.content),
      profile: null,
      headers: [],
      preview: [],
      profileSource: null,
    };
  }
  const guess = guessProfile(f.content);
  const saved = f.profile ? null : await savedProfile(db, bankAccountId);
  const profile = f.profile ?? saved ?? guess.profile;
  return {
    format,
    result: applyProfile(f.content, profile),
    profile,
    headers: guess.headers,
    preview: guess.preview,
    profileSource: f.profile ? "given" : saved ? "saved" : "guessed",
  };
}

/** Which parsed rows already exist (by dedupe hash or provider id) or repeat a FITID within the file. */
async function classify(db: Reader, bankAccountId: string, result: ParseResult) {
  const hashes = dedupeHashes(bankAccountId, result.rows);
  const existingHashes = new Set<string>();
  const existingProvider = new Set<string>();
  for (let i = 0; i < hashes.length; i += 500) {
    const chunk = hashes.slice(i, i + 500);
    const rows = await db
      .select({ h: org.bankTransactions.dedupeHash })
      .from(org.bankTransactions)
      .where(
        and(
          eq(org.bankTransactions.bankAccountId, bankAccountId),
          inArray(org.bankTransactions.dedupeHash, chunk),
        ),
      )
      .all();
    for (const r of rows) existingHashes.add(r.h);
  }
  const fitids = result.rows.map((r) => r.providerId).filter((x): x is string => Boolean(x));
  for (let i = 0; i < fitids.length; i += 500) {
    const rows = await db
      .select({ p: org.bankTransactions.providerTransactionId })
      .from(org.bankTransactions)
      .where(
        and(
          eq(org.bankTransactions.bankAccountId, bankAccountId),
          isNotNull(org.bankTransactions.providerTransactionId),
          inArray(org.bankTransactions.providerTransactionId, fitids.slice(i, i + 500)),
        ),
      )
      .all();
    for (const r of rows) if (r.p) existingProvider.add(r.p);
  }
  const seenFitid = new Set<string>();
  return result.rows.map((row, i) => {
    const hash = hashes[i]!;
    let duplicate = existingHashes.has(hash);
    if (row.providerId) {
      if (existingProvider.has(row.providerId) || seenFitid.has(row.providerId)) duplicate = true;
      seenFitid.add(row.providerId);
    }
    return { row, hash, duplicate };
  });
}

export async function previewImport(db: Reader, bankAccountId: string, f: ImportFile) {
  await mustGetBankAccount(db, bankAccountId);
  const p = await parseFile(db, bankAccountId, f);
  const rows = await classify(db, bankAccountId, p.result);
  const dupes = rows.filter((r) => r.duplicate).length;
  return {
    format: p.format,
    profile: p.profile,
    profile_source: p.profileSource,
    headers: p.headers,
    preview: p.preview.slice(0, 10),
    account: p.result.account ?? null,
    summary: {
      rows: rows.length + p.result.errors.length,
      new: rows.length - dupes,
      duplicates: dupes,
      errors: p.result.errors.length,
    },
    errors: p.result.errors.slice(0, 100),
    sample: rows.slice(0, 50).map((r) => ({
      date: r.row.date,
      amount: r.row.amount,
      description: r.row.description,
      payee: r.row.payee,
      duplicate: r.duplicate,
    })),
  };
}

export async function commitImportTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  bankAccountId: string,
  f: ImportFile & { save_profile?: boolean },
) {
  await mustGetBankAccount(tx, bankAccountId);
  const p = await parseFile(tx, bankAccountId, f);
  const rows = await classify(tx, bankAccountId, p.result);
  const fresh = rows.filter((r) => !r.duplicate);
  if (p.format === "csv" && p.profile && (f.save_profile ?? true))
    await saveProfileTx(tx, bankAccountId, p.profile);

  let batchId: string | null = null;
  const ids: string[] = [];
  if (fresh.length) {
    batchId = newId();
    await tx.insert(org.importBatches).values({
      id: batchId,
      bankAccountId,
      source: p.format,
      filename: f.filename.slice(0, 255),
      fileHash: sha256Hex(f.content),
      rowCount: rows.length + p.result.errors.length,
      importedCount: fresh.length,
      duplicateCount: rows.length - fresh.length,
      errorCount: p.result.errors.length,
      createdBy: a.userId,
    });
    const values = fresh.map(({ row, hash }) => {
      const id = newId();
      ids.push(id);
      return {
        id,
        bankAccountId,
        providerTransactionId: row.providerId,
        batchId,
        date: row.date,
        amount: row.amount,
        description: row.description,
        normalizedDescription: normalizeDescription(row.payee || row.description),
        payee: row.payee,
        dedupeHash: hash,
      };
    });
    for (let i = 0; i < values.length; i += 200) {
      await tx
        .insert(org.bankTransactions)
        .values(values.slice(i, i + 200))
        .onConflictDoNothing();
    }
    await appendAudit(tx, orgId, a, {
      action: "bank_import.commit",
      targetType: "import_batch",
      targetId: batchId,
      after: {
        bank_account_id: bankAccountId,
        format: p.format,
        filename: f.filename,
        imported: fresh.length,
        duplicates: rows.length - fresh.length,
        errors: p.result.errors.length,
      },
    });
  }
  const paired = await pairImportedTransfersTx(tx, orgId, ids);
  const rules = await applyRulesTx(tx, orgId, ids, systemActor(a.userId));
  return {
    batch_id: batchId,
    format: p.format,
    rows: rows.length + p.result.errors.length,
    imported: fresh.length,
    duplicates: rows.length - fresh.length,
    errors: p.result.errors.length,
    error_rows: p.result.errors.slice(0, 100),
    transfers_paired: paired,
    rules_applied: rules.applied,
    auto_posted: rules.posted,
    proposed: rules.proposed,
    suggested: rules.suggested,
  };
}
