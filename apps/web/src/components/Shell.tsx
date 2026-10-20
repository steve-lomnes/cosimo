import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../api/client";
import { groupOrgs } from "../lib/org";
import { useSession } from "../lib/session";
import { getTheme, setTheme, type Theme } from "../lib/theme";
import { useUpdateStatus } from "../lib/updates";
import { SnapReceipt } from "./SnapReceipt";
import { cx } from "./ui";

export interface NavItem {
  to: string;
  label: string;
  minRole?: "viewer" | "accountant" | "bookkeeper" | "owner";
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

export function navFor(orgId: string): NavGroup[] {
  const o = `/o/${orgId}`;
  return [
    { label: "", items: [{ to: `${o}`, label: "Dashboard" }] },
    {
      label: "Banking",
      items: [
        { to: `${o}/banking/categorize`, label: "Categorize" },
        { to: `${o}/banking/receipts`, label: "Receipts" },
        { to: `${o}/banking/import`, label: "Import" },
        { to: `${o}/banking/rules`, label: "Rules" },
        { to: `${o}/banking/reconcile`, label: "Reconcile" },
        { to: `${o}/banking/accounts`, label: "Accounts & connections" },
      ],
    },
    {
      label: "Sales",
      items: [
        { to: `${o}/sales/invoices`, label: "Invoices" },
        { to: `${o}/sales/customers`, label: "Customers" },
      ],
    },
    {
      label: "Expenses",
      items: [
        { to: `${o}/expenses/bills`, label: "Bills" },
        { to: `${o}/expenses/vendors`, label: "Vendors" },
      ],
    },
    {
      label: "Accounting",
      items: [
        { to: `${o}/accounting/review`, label: "Review queue" },
        { to: `${o}/accounting/accounts`, label: "Chart of accounts" },
        { to: `${o}/accounting/entries`, label: "Journal entries" },
      ],
    },
    { label: "", items: [{ to: `${o}/reports`, label: "Reports" }] },
    { label: "", items: [{ to: `${o}/settings`, label: "Settings" }] },
  ];
}

function ThemeToggle({ vertical }: { vertical?: boolean }) {
  const [t, setT] = useState<Theme>(getTheme());
  const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
  return (
    <button
      type="button"
      className={cx(
        "rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800",
        vertical ? "block w-full text-left text-sm touch:min-h-11" : "touch:min-h-11",
      )}
      onClick={() => {
        const n = next[t];
        setTheme(n);
        setT(n);
      }}
      title="Toggle theme"
    >
      {t === "system" ? "◐ Auto" : t === "light" ? "☀ Light" : "☾ Dark"}
    </button>
  );
}

export function OrgSwitcher({ orgId }: { orgId: string }) {
  const { data } = useSession();
  const navigate = useNavigate();
  const orgs = data?.orgs ?? [];
  const { real, sample } = groupOrgs(orgs);
  return (
    <select
      aria-label="Switch organization"
      value={orgId}
      onChange={(e) => {
        if (e.target.value === "__new") navigate({ to: "/orgs" });
        else navigate({ to: "/o/$orgId", params: { orgId: e.target.value } });
      }}
      className="min-w-0 max-w-[14rem] truncate rounded-md border-0 bg-transparent py-1 pl-1 pr-7 text-sm font-semibold touch:min-h-11 touch:text-base ring-1 ring-zinc-200 dark:ring-zinc-700"
    >
      {real.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
      {real.length > 0 && sample.length > 0 && <option disabled>──────────</option>}
      {sample.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
      <option disabled>──────────</option>
      <option value="__new">+ New organization…</option>
    </select>
  );
}

function UserMenu({ vertical }: { vertical?: boolean }) {
  const { data } = useSession();
  const update = useUpdateStatus();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const itemCls = cx(
    "rounded px-2 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
    "flex items-center touch:min-h-11",
  );
  return (
    <div className={cx("flex gap-1", vertical ? "flex-col text-sm" : "items-center text-xs")}>
      <Link to="/account" className={itemCls}>
        {data?.user?.name || data?.user?.email}
      </Link>
      {data?.user?.is_instance_admin && (
        <Link to="/admin" className={cx(itemCls, "relative")}>
          Admin
          {update.data?.status === "available" && (
            <span
              role="status"
              aria-label={`Update available: v${update.data.latest?.version}`}
              title={`Update available: v${update.data.latest?.version}`}
              className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400"
            />
          )}
        </Link>
      )}
      <button
        type="button"
        className={cx(itemCls, vertical && "text-left")}
        onClick={async () => {
          await api.POST("/api/v1/auth/logout");
          qc.clear();
          navigate({ to: "/login" });
        }}
      >
        Sign out
      </button>
    </div>
  );
}

export function Shell({ orgId, children }: { orgId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  // Close the drawer after navigating, on Escape, and keep the page behind it from scrolling.
  // biome-ignore lint/correctness/useExhaustiveDependencies: path is the trigger, not a value used inside
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);
  const groups = navFor(orgId);
  const nav = (
    <nav className="space-y-4 p-3" aria-label="Main">
      {groups.map((g, i) => (
        <div key={g.label || i}>
          {g.label && (
            <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              {g.label}
            </p>
          )}
          <ul className="space-y-0.5">
            {g.items.map((it) => {
              const active =
                it.to === `/o/${orgId}` ? path === it.to || path === `${it.to}/` : path.startsWith(it.to);
              return (
                <li key={it.to}>
                  <Link
                    to={it.to}
                    className={cx(
                      "block rounded-md px-2 py-1.5 text-sm touch:py-2.5",
                      active
                        ? "bg-brand-50 font-medium text-brand-700 dark:bg-zinc-800 dark:text-gold-400"
                        : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
                    )}
                  >
                    {it.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="hidden border-r border-zinc-200 bg-zinc-50 lg:block dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="flex h-14 items-center gap-2 border-b border-zinc-200 px-4 dark:border-zinc-800">
          <img src="/favicon.svg" alt="" className="h-6 w-6" />
          <span className="font-semibold tracking-tight">Cosimo</span>
        </div>
        {nav}
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col overflow-y-auto bg-white pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] dark:bg-zinc-900">
            <div className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200 px-4 dark:border-zinc-800">
              <img src="/favicon.svg" alt="" className="h-6 w-6" />
              <span className="font-semibold tracking-tight">Cosimo</span>
            </div>
            {nav}
            <div className="mt-auto space-y-1 border-t border-zinc-200 p-3 dark:border-zinc-800">
              <UserMenu vertical />
              <ThemeToggle vertical />
            </div>
          </div>
        </div>
      )}
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex min-h-14 items-center gap-3 border-b border-zinc-200 bg-white/90 px-4 pt-[env(safe-area-inset-top)] backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
          <button
            type="button"
            className="rounded p-1.5 touch:min-h-11 touch:min-w-11 lg:hidden"
            aria-label="Open menu"
            onClick={() => setOpen(true)}
          >
            ☰
          </button>
          <OrgSwitcher orgId={orgId} />
          <SnapReceipt className="ml-auto lg:hidden" />
          <div className="ml-auto hidden items-center gap-1 lg:flex">
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          {children}
        </main>
      </div>
    </div>
  );
}

export function PlainShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-zinc-50 dark:bg-zinc-950">
      <header className="flex min-h-14 flex-wrap items-center gap-x-2 border-b border-zinc-200 bg-white px-4 pt-[env(safe-area-inset-top)] dark:border-zinc-800 dark:bg-zinc-900">
        <Link to="/" className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="h-6 w-6" />
          <span className="font-semibold tracking-tight">Cosimo</span>
        </Link>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {children}
      </main>
    </div>
  );
}
