/**
 * Registers feature modules (routes, org seeders, CLI commands, jobs). Imported by the CLI entry
 * and by tests that build the app.
 */
import { registerContextPlugin } from "./context.ts";
import { registerApiModule, registerRootMount } from "./http/app.ts";
import { bankingRoutes } from "./http/routes/banking.ts";
import { documentRoutes } from "./http/routes/documents.ts";
import { exportRoutes } from "./http/routes/exports.ts";
import { ledgerRoutes } from "./http/routes/ledger.ts";
import { mountMcp } from "./http/routes/mcp.ts";
import { mountOAuth, oauthRoutes } from "./http/routes/oauth.ts";
import { mountPay, onlinePaymentRoutes } from "./http/routes/online-payments.ts";
import { operationsRoutes } from "./http/routes/operations.ts";
import { plaidRoutes } from "./http/routes/plaid.ts";
import { receiptRoutes } from "./http/routes/receipts.ts";
import { recurringRoutes } from "./http/routes/recurring.ts";
import { registerBankingJobs } from "./jobs/banking-jobs.ts";
import { registerDocumentJobs } from "./jobs/document-jobs.ts";
import { registerOpsJobs } from "./jobs/ops-jobs.ts";
import { registerPaymentJobs } from "./jobs/payment-jobs.ts";
import { registerPlaidJobs } from "./jobs/plaid-jobs.ts";
import { Mailer } from "./services/mailer.ts";
import { OAuthService } from "./services/oauth.ts";
import { createStore } from "./services/storage.ts";
import "./services/rules.ts";
import "./services/recurring.ts";
import { registerLedgerJobs } from "./jobs/ledger-jobs.ts";
import { Scheduler } from "./jobs/scheduler.ts";
import { coaSeeder } from "./services/accounts.ts";

// Shared services: scheduler (started by `cosimo serve`), mail, attachment storage
registerContextPlugin((ctx) => {
  ctx.services.scheduler = new Scheduler(ctx);
  ctx.services.mailer = new Mailer(ctx);
  ctx.services.storage = createStore(ctx.config, (v) => ctx.secrets.reveal(v));
});

// Phase 2: ledger
registerContextPlugin((ctx) => {
  ctx.orgs.addSeeder(coaSeeder);
  registerLedgerJobs(ctx.config.jobs.verify_weekday, ctx.config.anchoring.enabled);
});
registerApiModule(ledgerRoutes);

// Phase 3: banking, rules, review queue, reconciliation
registerContextPlugin(() => {
  registerBankingJobs();
});
registerApiModule(bankingRoutes);
// Receipt inbox (#89)
registerApiModule(receiptRoutes);

// Phase 4: receivables and payables
registerContextPlugin(() => {
  registerDocumentJobs();
});
registerApiModule(documentRoutes);
registerApiModule(recurringRoutes);
registerApiModule(exportRoutes);

// Phase 5: Plaid bank feeds
registerContextPlugin(() => {
  registerPlaidJobs();
});
registerApiModule(plaidRoutes);

// Online invoice payments (#55): provider settings, pay links, webhooks, and polling
registerContextPlugin(() => {
  registerPaymentJobs();
});
registerApiModule(onlinePaymentRoutes);
registerRootMount(mountPay);

// Phase 7: operations
registerContextPlugin((ctx) => {
  registerOpsJobs(
    () => ctx.config.backups.time,
    () => ctx.config.backups.mode !== "off",
  );
});
registerApiModule(operationsRoutes);

// Phase 8: OAuth 2.1 and MCP
registerContextPlugin((ctx) => {
  ctx.services.oauth = new OAuthService(ctx);
});
registerApiModule(oauthRoutes);
registerRootMount(mountOAuth);
registerRootMount(mountMcp);

// Business context for AI (SPEC §10.3)
import { notesRoutes } from "./http/routes/notes.ts";

registerApiModule(notesRoutes);

// Phase 8: dashboard and year-end package (SPEC §9.1, §9.2)
import { insightsRoutes } from "./http/routes/insights.ts";

registerApiModule(insightsRoutes);
