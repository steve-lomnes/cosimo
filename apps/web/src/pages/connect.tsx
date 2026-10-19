/**
 * AI connections (SPEC §10.4): the OAuth consent screen at /connect, connected apps for the
 * signed-in user and for an org's owners, and manual OAuth clients for instance admins.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, unwrap } from "../api/client";
import { PlainShell } from "../components/Shell";
import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  Loading,
  Select,
  Table,
  td,
  th,
} from "../components/ui";
import { fmtDateTime } from "../lib/format";
import { useOrgId } from "../lib/org";
import { useSession } from "../lib/session";

const ROLE_HELP: Record<string, string> = {
  owner: "Owner: everything, but its changes still go to your review queue",
  bookkeeper: "Bookkeeper: proposes categorizations, entries, rules, and invoice drafts for your review",
  accountant: "Accountant: read-only, including reports and the audit log",
  viewer: "Viewer: read-only",
};

/**
 * Only same-origin paths may be used as a post-login destination. `URL` parsing strips control
 * characters like tabs and newlines, so a plain `startsWith("/")` check can be tricked into
 * resolving to another origin (e.g. `/\t/evil.com` → `https://evil.com/`); resolve against the
 * origin and compare instead. Resolving also removes dot segments (`/.//evil.com` has the path
 * `//evil.com`), so collapse leading slashes to keep the result from reading as protocol-relative.
 */
export function safeNext(v: string | null | undefined, origin: string = window.location.origin) {
  if (!v?.startsWith("/")) return "/";
  try {
    const u = new URL(v, origin);
    if (u.origin !== origin) return "/";
    return `${u.pathname.replace(/^\/+/, "/")}${u.search}${u.hash}`;
  } catch {
    return "/";
  }
}

export function ConnectPage() {
  const session = useSession();
  const params = useMemo(() => Object.fromEntries(new URLSearchParams(window.location.search)), []);
  const signedIn = Boolean(session.data?.user);
  useEffect(() => {
    if (!session.isLoading && !signedIn)
      window.location.replace(
        `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
      );
  }, [session.isLoading, signedIn]);
  const info = useQuery({
    queryKey: ["oauth-consent", params],
    enabled: signedIn,
    retry: false,
    queryFn: () => unwrap(api.GET("/api/v1/oauth/consent", { params: { query: params as never } })),
  });
  // The checked orgs, each with the role it grants. The default is picked by the person, never
  // pre-selected; picking one also checks it.
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [defaultOrg, setDefaultOrg] = useState("");
  const startRole = (roles: string[]) =>
    roles.includes("bookkeeper") ? "bookkeeper" : (roles[0] ?? "viewer");
  const toggle = (o: { id: string; grantable_roles: string[] }, on: boolean) => {
    setPicked((cur) => {
      const next = { ...cur };
      if (on) next[o.id] = cur[o.id] ?? startRole(o.grantable_roles);
      else delete next[o.id];
      return next;
    });
    if (!on && defaultOrg === o.id) setDefaultOrg("");
  };
  const ready = Object.keys(picked).length > 0 && defaultOrg in picked;
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      unwrap(
        api.POST("/api/v1/oauth/consent", {
          body: {
            ...params,
            approve,
            orgs: Object.entries(picked).map(([org_id, role]) => ({ org_id, role })),
            default_org_id: defaultOrg || undefined,
          } as never,
        }),
      ),
    onSuccess: (r) => window.location.assign(r.redirect_to),
  });

  if (session.isLoading || !signedIn || info.isLoading) return <Loading />;
  return (
    <PlainShell>
      <div className="mx-auto max-w-lg">
        <Card title="Connect an AI assistant">
          {!info.data ? (
            <ErrorText error={info.error} />
          ) : info.data.error ? (
            <>
              <Alert kind="error">{info.data.error.message}</Alert>
              <Button className="mt-3" variant="secondary" onClick={() => decide.mutate(false)}>
                Return to the app
              </Button>
            </>
          ) : info.data.orgs.length === 0 ? (
            <Alert kind="warn">You aren't a member of any organization yet.</Alert>
          ) : (
            <div className="space-y-4 text-sm">
              <p>
                <strong>{info.data.client.name}</strong> wants to work with your books. You'll be sent back to{" "}
                <code>{info.data.client.redirect_host}</code>.
              </p>
              <fieldset className="space-y-2">
                <legend className="mb-1 font-medium">Organizations</legend>
                <p className="text-xs text-zinc-500">
                  Check each organization it may use and pick its access. Then pick the default: the one it
                  works in unless you name another.
                </p>
                {info.data.orgs.map((o) => {
                  const on = o.id in picked;
                  return (
                    <div
                      key={o.id}
                      className="space-y-2 rounded border border-zinc-200 p-2 dark:border-zinc-700"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={on} onChange={(e) => toggle(o, e.target.checked)} />
                          <span>{o.name}</span>
                        </label>
                        <label className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                          <input
                            type="radio"
                            name="default-org"
                            aria-label={`Default: ${o.name}`}
                            checked={defaultOrg === o.id}
                            onChange={() => {
                              toggle(o, true);
                              setDefaultOrg(o.id);
                            }}
                          />
                          Default
                        </label>
                      </div>
                      {on && (
                        <Select
                          aria-label={`Access for ${o.name}`}
                          value={picked[o.id]}
                          onChange={(e) => setPicked((cur) => ({ ...cur, [o.id]: e.target.value }))}
                        >
                          {o.grantable_roles.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_HELP[r] ?? r}
                            </option>
                          ))}
                        </Select>
                      )}
                    </div>
                  );
                })}
                {!ready && (
                  <p className="text-xs text-zinc-500">
                    {Object.keys(picked).length === 0
                      ? "Check at least one organization."
                      : "Pick which checked organization is the default."}
                  </p>
                )}
              </fieldset>
              <ul className="list-inside list-disc text-zinc-600 dark:text-zinc-400">
                <li>
                  Everything it writes to the books, corrections included, waits in your review queue until
                  you approve it. Only contacts and notes apply directly.
                </li>
                <li>It can't approve its own proposals, void, delete, or change lock dates.</li>
                <li>
                  It can't add organizations or change the default; only you can, from your account page. You
                  can disconnect it, or remove one organization, at any time there.
                </li>
              </ul>
              <div className="flex gap-2">
                <Button
                  disabled={!ready}
                  loading={decide.isPending && decide.variables === true}
                  onClick={() => decide.mutate(true)}
                >
                  Allow
                </Button>
                <Button variant="secondary" onClick={() => decide.mutate(false)}>
                  Deny
                </Button>
              </div>
              <ErrorText error={decide.error} />
            </div>
          )}
        </Card>
      </div>
    </PlainShell>
  );
}

type Connection = {
  id: string;
  client_name: string;
  user_email: string;
  default_org_id: string | null;
  orgs: { org_id: string; org_name: string; role: string }[];
  created_at: string;
  last_used_at: string | null;
};

const lastUsed = (c: Connection) => (c.last_used_at ? fmtDateTime(c.last_used_at) : "never");

/** Disconnect a whole connection, or (with `orgId`) remove one org from it. */
function useRevoke(keys: string[][]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, orgId }: { id: string; orgId?: string }) =>
      orgId
        ? unwrap(
            api.DELETE("/api/v1/oauth/connections/{grantId}/orgs/{orgId}", {
              params: { path: { grantId: id, orgId } },
            }),
          )
        : unwrap(api.DELETE("/api/v1/oauth/connections/{grantId}", { params: { path: { grantId: id } } })),
    onSuccess: () => {
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
    },
  });
}

/** One connection: a row per org, with per-org removal and the default-org picker. */
function ConnectionCard({
  c,
  onRevoke,
  onDefault,
}: {
  c: Connection;
  onRevoke: (orgId?: string) => void;
  onDefault: (orgId: string) => void;
}) {
  return (
    <div className="rounded border border-zinc-200 dark:border-zinc-700">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-700">
        <div>
          <div className="font-medium">{c.client_name}</div>
          <div className="text-xs text-zinc-500">Last used {lastUsed(c)}</div>
        </div>
        <Button size="sm" variant="secondary" onClick={() => onRevoke()}>
          Disconnect
        </Button>
      </div>
      {!c.default_org_id && c.orgs.length > 1 && (
        <p className="px-3 pt-2 text-xs text-amber-700 dark:text-amber-400">
          No default organization: the assistant must name one on every call. Pick a default below.
        </p>
      )}
      <Table>
        <thead>
          <tr>
            <th className={th}>Organization</th>
            <th className={th}>Access</th>
            <th className={th}>Default</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody>
          {c.orgs.map((o) => (
            <tr key={o.org_id}>
              <td className={td}>{o.org_name}</td>
              <td className={td}>
                <Badge>{o.role}</Badge>
              </td>
              <td className={td}>
                <input
                  type="radio"
                  name={`default-${c.id}`}
                  aria-label={`Default for ${c.client_name}: ${o.org_name}`}
                  checked={c.default_org_id === o.org_id}
                  onChange={() => onDefault(o.org_id)}
                />
              </td>
              <td className={`${td} text-right`}>
                {c.orgs.length > 1 && (
                  <Button size="sm" variant="secondary" onClick={() => onRevoke(o.org_id)}>
                    Remove
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

/** Account page: the user's own connected apps. */
export function MyConnections() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["oauth-connections"],
    queryFn: () => unwrap(api.GET("/api/v1/oauth/connections")),
  });
  const revoke = useRevoke([["oauth-connections"]]);
  const setDefault = useMutation({
    mutationFn: ({ id, orgId }: { id: string; orgId: string }) =>
      unwrap(
        api.PATCH("/api/v1/oauth/connections/{grantId}", {
          params: { path: { grantId: id } },
          body: { default_org_id: orgId },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["oauth-connections"] }),
  });
  const rows = q.data?.data;
  return (
    <Card title="Connected AI apps">
      <p className="mb-3 text-sm text-zinc-500">
        Apps you connected through “Add connector” (OAuth). Each can work in the organizations listed under
        it, in the default one unless it names another. Disconnecting or removing an organization stops it at
        once.
      </p>
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No connected apps.</p>
      ) : (
        <div className="space-y-4">
          {rows.map((c) => (
            <ConnectionCard
              key={c.id}
              c={c}
              onRevoke={(orgId) => revoke.mutate({ id: c.id, orgId })}
              onDefault={(orgId) => setDefault.mutate({ id: c.id, orgId })}
            />
          ))}
        </div>
      )}
      <ErrorText error={revoke.error ?? setDefault.error} />
    </Card>
  );
}

/** Org settings: every app connected to this org (owners). Disconnecting removes only this org. */
export function OrgConnections() {
  const orgId = useOrgId();
  const q = useQuery({
    queryKey: ["org-oauth-connections", orgId],
    queryFn: () => unwrap(api.GET("/api/v1/orgs/{orgId}/oauth/connections", { params: { path: { orgId } } })),
  });
  const revoke = useRevoke([["org-oauth-connections", orgId], ["oauth-connections"]]);
  const rows = q.data?.data;
  return (
    <div className="space-y-6">
      <Card title="Connect an AI assistant">
        <p className="text-sm">
          Add this server as a connector in Claude or another MCP client using this URL; you'll sign in and
          pick the organizations it may use:
        </p>
        <code className="mt-2 block break-all rounded bg-zinc-100 px-2 py-1 text-sm dark:bg-zinc-800">
          {`${window.location.origin}/mcp`}
        </code>
        <p className="mt-2 text-xs text-zinc-500">
          Clients without OAuth can use a personal API token (Account → Personal API tokens) as a Bearer
          token.
        </p>
      </Card>
      <Card title="Connected AI apps">
        {!rows ? (
          <ErrorText error={q.error} />
        ) : rows.length === 0 ? (
          <p className="text-sm text-zinc-500">No connected apps.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>App</th>
                <th className={th}>Connected by</th>
                <th className={th}>Access</th>
                <th className={th}>Last used</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className={td}>{c.client_name}</td>
                  <td className={td}>{c.user_email}</td>
                  <td className={td}>
                    <Badge>{c.orgs.find((o) => o.org_id === orgId)?.role ?? ""}</Badge>
                  </td>
                  <td className={td}>{lastUsed(c)}</td>
                  <td className={`${td} text-right`}>
                    <Button size="sm" variant="secondary" onClick={() => revoke.mutate({ id: c.id, orgId })}>
                      Disconnect
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <ErrorText error={revoke.error} />
      </Card>
    </div>
  );
}

/** Admin: manually registered OAuth clients. */
export function OAuthClients() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["oauth-clients"],
    queryFn: () => unwrap(api.GET("/api/v1/admin/oauth-clients")),
  });
  const [name, setName] = useState("");
  const [uri, setUri] = useState("");
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/admin/oauth-clients", {
          body: { client_name: name, redirect_uris: uri.split(/\s+/).filter(Boolean), confidential: true },
        }),
      ),
    onSuccess: () => {
      setName("");
      setUri("");
      qc.invalidateQueries({ queryKey: ["oauth-clients"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE("/api/v1/admin/oauth-clients/{clientId}", { params: { path: { clientId: id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["oauth-clients"] }),
  });
  const active = (q.data?.data ?? []).filter((c) => !c.revoked_at);
  return (
    <Card title="OAuth clients">
      <p className="mb-3 text-sm text-zinc-500">
        Register a client by hand when dynamic registration is off. The client secret is shown once.
      </p>
      {create.data && (
        <Alert kind="success">
          Client ID <code className="break-all">{create.data.client_id}</code>
          <br />
          Secret (copy it now): <code className="break-all">{create.data.client_secret}</code>
        </Alert>
      )}
      <form
        className="my-3 grid gap-3 sm:grid-cols-5 sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Client name" className="sm:col-span-2">
          {(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Redirect URI(s)" className="sm:col-span-2">
          {(id) => (
            <Input
              id={id}
              required
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              placeholder="https://…"
            />
          )}
        </Field>
        <Button type="submit" loading={create.isPending}>
          Register
        </Button>
      </form>
      <ErrorText error={create.error ?? revoke.error} />
      {active.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th className={th}>Client</th>
              <th className={th}>Registered</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {active.map((c) => (
              <tr key={c.client_id}>
                <td className={td}>
                  {c.client_name}
                  <div className="text-xs text-zinc-500">{c.redirect_uris.join(", ")}</div>
                </td>
                <td className={td}>
                  <Badge tone={c.registered_via === "manual" ? "blue" : "zinc"}>{c.registered_via}</Badge>{" "}
                  {fmtDateTime(c.created_at)}
                </td>
                <td className={`${td} text-right`}>
                  <Button size="sm" variant="secondary" onClick={() => revoke.mutate(c.client_id)}>
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
