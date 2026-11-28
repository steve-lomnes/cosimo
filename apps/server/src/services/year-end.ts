/**
 * Year-end package (SPEC §9.1): one ZIP with every report a CPA needs for a fiscal year, in PDF and
 * CSV, plus README.txt and chain.json holding the ledger and audit chain heads (SPEC §6.5).
 *
 * "Year" means the fiscal year that ends in that calendar year. With a January fiscal start this is
 * the calendar year; with a July start, year 2026 is 2025-07-01 to 2026-06-30. The 1099 summary is
 * always the calendar year `year`, because 1099s are filed per calendar year.
 */
import { org } from "@cosimo/db";
import { addMonths, fiscalYearEnd, VERSION } from "@cosimo/shared";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import type { AppContext } from "../context.ts";
import { anchorNow, anchorPackageFiles } from "./anchors.ts";
import { listAttachments } from "./attachments.ts";
import { checkpoint } from "./chain.ts";
import { settingsRow } from "./ledger.ts";
import { reconciliationFiles } from "./reconcile.ts";
import { type ReportKey, type ReportParams, reportCsv, reportPdf, runReport } from "./reports.ts";
import type { BlobStore } from "./storage.ts";
import type { OrgHandle } from "./types.ts";

export interface YearEndPeriod {
  from: string;
  to: string;
}

const STATEMENT_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "text/csv": "csv",
  "text/plain": "txt",
};

/** File extension for a statement, from its mime type (the original name's extension if unknown). */
function statementExt(mime: string, filename: string) {
  return STATEMENT_EXT[mime] ?? (/\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase() || "bin");
}

/** The fiscal year that ends in calendar year `year`. */
export function fiscalYearPeriod(year: number, fyStartMonth: number): YearEndPeriod {
  const from =
    fyStartMonth === 1 ? `${year}-01-01` : `${year - 1}-${String(fyStartMonth).padStart(2, "0")}-01`;
  return { from, to: fiscalYearEnd(from) };
}

/** Lower-case file-name slug of the org name. */
export function orgSlug(name: string, fallback: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

export interface YearEndResult {
  filename: string;
  bytes: Uint8Array;
  files: string[];
  chain: ChainJson;
}

export interface ChainJson {
  ledger: { seq: number; hash: string };
  audit: { seq: number; hash: string };
  org_id: string;
  generated_at: string;
  /** Public timestamps included under anchors/ (see anchors.ts `anchorPackageFiles`). */
  anchors: Awaited<ReturnType<typeof anchorPackageFiles>>["anchors"];
}

const REPORTS: { key: ReportKey; file: string; label: string }[] = [
  { key: "profit_and_loss", file: "01-profit-and-loss", label: "Profit and Loss" },
  { key: "balance_sheet", file: "02-balance-sheet", label: "Balance Sheet (as of year end)" },
  { key: "trial_balance", file: "03-trial-balance", label: "Trial Balance (as of year end)" },
  { key: "general_ledger", file: "04-general-ledger", label: "General Ledger (accrual)" },
  { key: "tax_line_summary", file: "05-tax-line-summary", label: "Tax Line Summary" },
  { key: "vendor_1099", file: "06-1099-vendor-summary", label: "1099 Vendor Summary (calendar year)" },
  { key: "ar_aging", file: "07-ar-aging", label: "Accounts Receivable Aging (as of year end)" },
  { key: "ap_aging", file: "08-ap-aging", label: "Accounts Payable Aging (as of year end)" },
];

export async function buildYearEndPackage(
  h: OrgHandle,
  orgId: string,
  orgName: string,
  year: number,
  /** With a context and anchoring on, the year-end heads are timestamped first (best effort). */
  opts: { ctx?: AppContext } = {},
): Promise<YearEndResult> {
  const db = h.db;
  const s = await settingsRow(db);
  const basis = s.defaultBasis;
  const period = fiscalYearPeriod(year, s.fiscalYearStartMonth);
  const generatedAt = new Date().toISOString();
  const entries: Record<string, Uint8Array> = {};
  const listing: string[] = [];

  for (const r of REPORTS) {
    const params: ReportParams =
      r.key === "profit_and_loss" || r.key === "general_ledger" || r.key === "tax_line_summary"
        ? { from: period.from, to: period.to, basis }
        : r.key === "vendor_1099"
          ? { to: `${year}-12-31` }
          : { as_of: period.to, basis };
    const report = await runReport(db, orgId, orgName, r.key, params);
    report.meta.generated_at = generatedAt;
    entries[`${r.file}.pdf`] = await reportPdf(report);
    entries[`${r.file}.csv`] = strToU8(reportCsv(report));
    listing.push(`${r.file}.pdf / .csv  ${r.label}`);
  }

  // Reconciliations whose statement ends in the final month of the fiscal year.
  const lastMonthStart = addMonths(period.from, 11);
  const recons = await db
    .select({ id: org.reconciliations.id, status: org.reconciliations.status })
    .from(org.reconciliations)
    .where(
      and(
        gte(org.reconciliations.statementEndDate, lastMonthStart),
        lte(org.reconciliations.statementEndDate, period.to),
      ),
    )
    .orderBy(asc(org.reconciliations.statementEndDate), asc(org.reconciliations.id))
    .all();
  const completed = recons.filter((r) => r.status === "completed");
  const missingStatements: string[] = [];
  const skipped = recons.filter((r) => r.status === "in_progress").length;
  for (const rec of completed) {
    const f = await reconciliationFiles(db, rec.id, orgName, generatedAt);
    let base = `09-reconciliations/${f.name}`;
    for (let i = 2; entries[`${base}.pdf`]; i++) base = `09-reconciliations/${f.name}-${i}`;
    entries[`${base}.pdf`] = f.pdf;
    entries[`${base}.csv`] = strToU8(f.csv);
    listing.push(`${base}.pdf / .csv  Reconciliation report`);
    // The statement files, next to the report they support.
    const statements = await listAttachments(db, { type: "reconciliation", id: rec.id });
    const store = opts.ctx?.services.storage as BlobStore | undefined;
    for (const [i, att] of statements.entries()) {
      const key = (
        await db
          .select({ k: org.attachments.storageKey })
          .from(org.attachments)
          .where(eq(org.attachments.id, att.id))
          .get()
      )?.k;
      const bytes = key && store ? await store.get(key) : null;
      if (!bytes) {
        missingStatements.push(`${att.filename} (${f.name})`);
        continue;
      }
      const path = `${base}-statement${statements.length > 1 ? `-${i + 1}` : ""}.${statementExt(att.mime_type, att.filename)}`;
      entries[path] = bytes;
      listing.push(`${path}  Statement`);
    }
  }

  // Anchor the chain heads: record a checkpoint and put the same heads in chain.json.
  const rows = await h.write((tx) => checkpoint(tx, orgId, "year_end"));
  const head = (c: "ledger" | "audit") => {
    const r = rows.find((x) => x.chain === c)!;
    return { seq: r.seq, hash: r.headHash };
  };
  // Timestamp those heads publicly. A network failure must not stop the package.
  let anchorNote: string | null = null;
  if (opts.ctx?.config.anchoring.enabled) {
    try {
      const r = await anchorNow(opts.ctx, h, orgId, "year_end");
      if (r.status !== "anchored" && r.status !== "unchanged") anchorNote = r.message;
    } catch (e) {
      anchorNote = `Timestamping failed: ${(e as Error).message}`;
    }
  }
  const anchored = await anchorPackageFiles(h, orgId);
  Object.assign(entries, anchored.files);
  const chain: ChainJson = {
    ledger: head("ledger"),
    audit: head("audit"),
    org_id: orgId,
    generated_at: generatedAt,
    anchors: anchored.anchors,
  };

  const basisLabel = basis === "cash" ? "Cash" : "Accrual";
  const notYetEnded = period.to >= generatedAt.slice(0, 10);
  const readme = [
    `${orgName}`,
    `Year-end package for fiscal year ${year}`,
    "",
    `Period:        ${period.from} to ${period.to}`,
    `Basis:         ${basisLabel} (the organization's default basis)`,
    `Generated at:  ${generatedAt}`,
    `Cosimo:        ${VERSION}`,
    "",
    "Notes",
    `- The P&L, balance sheet, trial balance and tax line summary use the ${basis} basis.`,
    "  The general ledger lists posted lines and is always accrual. Aging and the 1099 summary",
    "  do not depend on basis.",
    `- The 1099 vendor summary covers calendar year ${year} (1099s are filed per calendar year).`,
    `- Reconciliation reports cover completed reconciliations with a statement end date from`,
    `  ${lastMonthStart} to ${period.to}.${completed.length ? "" : " There were none."}` +
      (skipped ? ` ${skipped} in-progress reconciliation(s) were not included.` : ""),
    ...(missingStatements.length
      ? [
          `- Statement files that could not be read from storage were left out: ${missingStatements.join("; ")}.`,
        ]
      : []),
    ...(notYetEnded ? [`- This fiscal year had not ended when the package was generated.`] : []),
    "",
    "Files",
    ...listing.map((l) => `- ${l}`),
    "- README.txt  This file",
    "- chain.json  Ledger and audit chain heads at generation time, and the public timestamps included",
    ...(anchored.anchors.length
      ? ["- anchors/    Public timestamps of the chain heads, checkable without Cosimo (see below)"]
      : []),
    "",
    "Chain heads",
    `Ledger chain: seq ${chain.ledger.seq}, hash ${chain.ledger.hash}`,
    `Audit chain:  seq ${chain.audit.seq}, hash ${chain.audit.hash}`,
    "",
    "Every posted journal entry and every audit log row in Cosimo is linked into a SHA-256 hash",
    "chain. The hashes above are the heads of those chains when this package was generated. Anyone",
    "holding this file can later run `cosimo verify` (or Settings > Verify) and compare the entry at",
    "these sequence numbers with these hashes to check that the books for this period have not been",
    "rewritten since. This makes the books tamper-evident, not tamper-proof: someone with full",
    "database access could rebuild the whole chain, but the result would no longer match this copy.",
    "",
    ...anchorReadme(anchored.anchors, anchorNote),
  ].join("\r\n");

  entries["README.txt"] = strToU8(readme);
  entries["chain.json"] = strToU8(`${JSON.stringify(chain, null, 2)}\n`);
  const bytes = zipSync(entries, { level: 6 });
  return {
    filename: `${orgSlug(orgName, orgId)}-${year}-year-end.zip`,
    bytes,
    files: Object.keys(entries),
    chain,
  };
}

/** README section on the public timestamps in anchors/, with the commands to check them. */
function anchorReadme(anchors: ChainJson["anchors"], note: string | null): string[] {
  if (!anchors.length)
    return note ? ["Public timestamps", `No public timestamps are included. ${note}`, ""] : [];
  const lines = [
    "Public timestamps",
    "anchors/ holds public timestamps of the chain heads, so a third party can confirm the books",
    "through those heads existed by the stated time without trusting Cosimo or its database. Each",
    "anchor-<n>.txt is the text that was timestamped (the ledger and audit chain heads at ledger link",
    "n); its SHA-256 is what the proofs commit to.",
    "",
  ];
  for (const a of anchors) {
    const proofs = a.proofs
      .map((p) =>
        p.kind === "ots"
          ? `OpenTimestamps via ${p.service} (${p.status === "complete" ? `Bitcoin block ${p.block_height}, ${p.attested_at}` : "pending"})`
          : `RFC 3161 via ${p.service} (${p.attested_at})`,
      )
      .join("; ");
    lines.push(`- ${a.file}: ledger link ${a.ledger.seq}, audit link ${a.audit.seq}. ${proofs}`);
  }
  lines.push(
    "",
    "To check them:",
    "- OpenTimestamps (Bitcoin): install the OpenTimestamps client (pip install opentimestamps-client).",
    "  A proof still pending when the package was made completes with",
    "  `ots upgrade anchors/anchor-<n>.txt.ots` once its Bitcoin block is mined. Then, with a Bitcoin",
    "  node, `ots verify anchors/anchor-<n>.txt.ots`; without one, `ots info anchors/anchor-<n>.txt.ots`",
    "  ends with the block height and merkle root to compare on any block explorer.",
    "- RFC 3161: `openssl ts -verify -data anchors/anchor-<n>.txt -in anchors/anchor-<n>.tsr",
    "  -CAfile anchors/cacert.pem -untrusted anchors/tsa.crt`. Compare cacert.pem with the authority's",
    "  published root (for FreeTSA, https://freetsa.org/files/cacert.pem) rather than trusting this copy.",
    "- Then compare the hashes in anchor-<n>.txt with the ledger and audit hashes at those links in an",
    "  export of the books (docs/chain-format.md in the Cosimo source explains the format).",
    "",
  );
  if (note) lines.push(`Note: ${note}`, "");
  return lines;
}
