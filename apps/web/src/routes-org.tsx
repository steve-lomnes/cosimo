import { type AnyRoute, createRoute, redirect } from "@tanstack/react-router";
import { RecurringDetail, RecurringForm } from "./components/recurring";
import { AccountsPage } from "./pages/accounts";
import { BankAccountsPage, ImportPage } from "./pages/bank-accounts";
import { BillPage, BillsPage, NewBillPage } from "./pages/bills";
import { CategorizePage } from "./pages/categorize";
import { ContactsPage } from "./pages/contacts";
import { EntriesPage, EntryPage, NewEntryPage, validateEntrySearch } from "./pages/entries";
import { InvoicePage, InvoicesPage, NewInvoicePage } from "./pages/invoices";
import { OpeningBalancesPage } from "./pages/ledger-settings";
import { NewReceiptPage, ReceiptPage, ReceiptsPage } from "./pages/receipts";
import { ReconcileListPage, ReconcilePage } from "./pages/reconcile";
import { ReportsPage, validateReportSearch } from "./pages/reports";
import { ReviewQueuePage } from "./pages/review";
import { RulesPage } from "./pages/rules";

const recurringSearch = (s: Record<string, unknown>) => ({
  from: typeof s.from === "string" ? s.from : undefined,
});

const msgSearch = (s: Record<string, unknown>) => ({ msg: typeof s.msg === "string" ? s.msg : undefined });

/** Org-scoped feature routes, added phase by phase. */
export function orgChildRoutes(parent: AnyRoute): AnyRoute[] {
  const r = (
    path: string,
    component: () => React.ReactNode,
    validateSearch?: (s: Record<string, unknown>) => object,
  ) => createRoute({ getParentRoute: () => parent, path, component, validateSearch }) as unknown as AnyRoute;
  return [
    r("/accounting/accounts", AccountsPage),
    r("/accounting/opening-balances", OpeningBalancesPage),
    r("/accounting/entries", EntriesPage, validateEntrySearch),
    r("/accounting/entries/new", NewEntryPage),
    r("/accounting/entries/recurring", EntriesPage),
    r("/accounting/entries/recurring/new", () => <RecurringForm kind="entry" />, recurringSearch),
    r("/accounting/entries/recurring/$templateId", () => <RecurringDetail kind="entry" />),
    r("/accounting/entries/recurring/$templateId/edit", () => <RecurringForm kind="entry" />),
    r("/accounting/entries/$entryId", EntryPage, msgSearch),
    r("/reports", ReportsPage, validateReportSearch),
    r("/banking/accounts", BankAccountsPage),
    r("/banking/import", ImportPage, (s) => ({
      account: typeof s.account === "string" ? s.account : undefined,
    })),
    r("/banking/categorize", CategorizePage, (s) => ({
      account: typeof s.account === "string" ? s.account : undefined,
      status: typeof s.status === "string" ? s.status : undefined,
    })),
    // The page was called "Bank review" until it was renamed; keep old bookmarks working.
    createRoute({
      getParentRoute: () => parent,
      path: "/banking/review",
      beforeLoad: ({ location }) => {
        throw redirect({ href: location.href.replace("/banking/review", "/banking/categorize") });
      },
    }) as unknown as AnyRoute,
    r("/banking/receipts", ReceiptsPage),
    r("/banking/receipts/new", NewReceiptPage),
    r("/banking/receipts/$receiptId", ReceiptPage),
    r("/banking/rules", RulesPage),
    r("/banking/reconcile", ReconcileListPage),
    r("/banking/reconcile/$reconId", ReconcilePage),
    r("/accounting/review", ReviewQueuePage),
    r("/sales/invoices", InvoicesPage),
    r("/sales/invoices/new", NewInvoicePage),
    r("/sales/invoices/recurring", InvoicesPage),
    r("/sales/invoices/recurring/new", () => <RecurringForm kind="invoice" />, recurringSearch),
    r("/sales/invoices/recurring/$templateId", () => <RecurringDetail kind="invoice" />),
    r("/sales/invoices/recurring/$templateId/edit", () => <RecurringForm kind="invoice" />),
    r("/sales/invoices/$invoiceId", InvoicePage),
    // /sales/recurring predates the per-page Recurring tabs (#35); keep old bookmarks working.
    createRoute({
      getParentRoute: () => parent,
      path: "/sales/recurring",
      beforeLoad: ({ location }) => {
        throw redirect({ href: location.href.replace("/sales/recurring", "/sales/invoices/recurring") });
      },
    }) as unknown as AnyRoute,
    r("/sales/customers", () => <ContactsPage kind="customer" />),
    r("/expenses/bills", BillsPage),
    r("/expenses/bills/new", NewBillPage),
    r("/expenses/bills/recurring", BillsPage),
    r("/expenses/bills/recurring/new", () => <RecurringForm kind="bill" />, recurringSearch),
    r("/expenses/bills/recurring/$templateId", () => <RecurringDetail kind="bill" />),
    r("/expenses/bills/recurring/$templateId/edit", () => <RecurringForm kind="bill" />),
    r("/expenses/bills/$billId", BillPage),
    r("/expenses/vendors", () => <ContactsPage kind="vendor" />),
  ];
}
