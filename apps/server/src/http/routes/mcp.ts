/**
 * MCP endpoint (SPEC §10.2): streamable HTTP at `/mcp`, stateless, answering each JSON-RPC POST
 * with `application/json` (no server-initiated SSE stream; GET returns 405).
 *
 * Authentication is a bearer token only (OAuth access token or API token); cookies are ignored so
 * a browser session can't be used cross-site. Unauthenticated requests get 401 with
 * `WWW-Authenticate` pointing at the protected resource metadata, which starts the OAuth flow.
 * Every call acts as the `mcp` actor in one of the token's organizations: the one the call names
 * (`org_id` on a tool, `org://{org_id}/…` for a resource) or the connection's default, and only
 * if the token covers it.
 */
import { minRole, VERSION } from "@cosimo/shared";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppContext } from "../../context.ts";
import { TOKEN_PREFIX } from "../../crypto.ts";
import {
  type ConnOrg,
  callTool,
  describeOrgs,
  listTools,
  type McpConn,
  orgNotesMarkdown,
  orgProfileMarkdown,
  splitContent,
  type ToolCtx,
  ToolInputError,
} from "../../services/mcp-tools.ts";
import { effectiveDefault, type OAuthService } from "../../services/oauth.ts";
import { ApiError, forbidden } from "../errors.ts";
import { clientIp, tokenGrants } from "../middleware.ts";
import type { AppEnv, OrgScope, Principal } from "../types.ts";

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Cosimo is double-entry bookkeeping. A connection covers one or more organizations, with a role in each; one of them is the default.
- Call list_orgs to see the organizations, your role in each, and which is the default. Every other tool takes an optional org_id; omit it to work in the default organization. Only the person can change the default or which organizations you can reach.
- Before working in an organization, read its business profile (what the business does, which accounts to use) and its notes (what has been learned before): get_org_profile and get_org_notes, or the resources org://profile and org://notes (default organization) and org://{org_id}/profile and org://{org_id}/notes.
- Money is integer cents in the org's currency (123456 = $1,234.56); divide by 100 before showing an amount to a person. Journal lines are debit-positive; bank amounts are positive for money in.
- Every write tool needs a short rationale. Writes are proposals: they wait in the review queue until a person approves them. Tell the person what is waiting (list_pending_reviews).
- You cannot approve, reject, void, delete, or change lock dates. Reversals, replacements, and payment date changes are proposals.
- When you learn something durable about how this business books things, record it with append_note.`;

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description: string;
  mimeType: string;
  read(t: ToolCtx): Promise<string>;
}
const resources: McpResource[] = [];
export function registerMcpResource(r: McpResource) {
  resources.push(r);
}

type JsonRpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const rpcError = (id: JsonRpc["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

function challenge(c: Context<AppEnv>, ctx: AppContext, error?: string, description?: string) {
  const base = ctx.config.server.public_url.replace(/\/$/, "");
  const parts = [`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  c.header("www-authenticate", `Bearer ${parts.join(", ")}`);
  return c.json(
    { error: { code: error ?? "unauthorized", message: description ?? "Authentication required." } },
    401,
  );
}

async function principalFor(ctx: AppContext, token: string): Promise<Principal | null> {
  if (token.startsWith(TOKEN_PREFIX.api)) {
    const row = await ctx.users.resolveApiToken(token);
    if (!row) return null;
    return {
      kind: "api_token",
      userId: row.user.id,
      email: row.user.email,
      name: row.user.name,
      isInstanceAdmin: false,
      apiTokenId: row.token.id,
      orgId: row.token.orgId,
      roleCap: row.token.role,
      proposeOnly: row.token.proposeOnly,
    };
  }
  if (token.startsWith(TOKEN_PREFIX.oauthAccess))
    return (ctx.services.oauth as OAuthService).resolveAccessToken(token);
  return null;
}

/**
 * The orgs this token covers, keeping only those where the user is still a member, each capped at
 * the lower of the grant's role and the membership role. Null when none is left.
 */
async function connectionFor(ctx: AppContext, p: Principal, ip: string): Promise<McpConn | null> {
  const orgs: ConnOrg[] = [];
  for (const g of tokenGrants(p) ?? []) {
    const member = await ctx.orgs.membership(p.userId, g.orgId);
    if (member) orgs.push({ id: g.orgId, role: minRole(g.roleCap, member) });
  }
  if (!orgs.length) return null;
  const ids = orgs.map((o) => o.id);
  const proposeOnly = p.kind === "oauth" ? true : (p.proposeOnly ?? false);
  const conn: McpConn = {
    ctx,
    orgs,
    defaultOrgId: effectiveDefault(p.kind === "oauth" ? (p.defaultOrgId ?? null) : (p.orgId ?? null), ids),
    proposeOnly,
    async scope(orgId) {
      const id = orgId ?? conn.defaultOrgId;
      const o = id ? orgs.find((x) => x.id === id) : undefined;
      if (!o)
        throw forbidden(
          `${id ? `This connection is not authorized for organization ${id}.` : "This connection has no default organization, so pass org_id."} ${await describeOrgs(conn)}`,
        );
      const handle = await ctx.orgs.open(o.id);
      if (!handle) throw forbidden(`Organization ${o.id} is not available. ${await describeOrgs(conn)}`);
      return {
        id: o.id,
        handle,
        role: o.role,
        actor: {
          actor: "mcp",
          role: o.role,
          userId: p.userId,
          apiTokenId: p.apiTokenId ?? null,
          oauthClientId: p.oauthClientId ?? null,
          ip,
          proposeOnly,
          displayName: p.name || p.email,
        },
      };
    },
  };
  return conn;
}

function toolResult(out: unknown) {
  // A tool can send content beyond its JSON result (a receipt's image), after the text item.
  const { value, extra } = splitContent(out);
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }, ...extra],
    ...(value && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value } : {}),
    isError: false,
  };
}

function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** `org://profile` reads the default org; `org://{org_id}/profile` reads a named one. */
function parseResourceUri(uri: string) {
  const m = /^org:\/\/([^/]+)\/([^/]+)$/.exec(uri);
  return m ? { orgId: m[1], uri: `org://${m[2]}` } : { orgId: undefined, uri };
}

async function handle(conn: McpConn, msg: JsonRpc) {
  const id = msg.id;
  const params = msg.params ?? {};
  switch (msg.method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
          },
          serverInfo: { name: "cosimo", title: "Cosimo bookkeeping", version: VERSION },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: listTools() } };
    case "tools/call": {
      const name = String(params.name ?? "");
      try {
        const out = await callTool(conn, name, params.arguments);
        if (out === null) return rpcError(id, -32602, `Unknown tool: ${name}`);
        return { jsonrpc: "2.0", id, result: toolResult(out) };
      } catch (e) {
        if (e instanceof ToolInputError)
          return { jsonrpc: "2.0", id, result: toolError(`Invalid input: ${e.message}`) };
        if (e instanceof ApiError)
          return { jsonrpc: "2.0", id, result: toolError(`${e.message} (${e.code})`) };
        throw e;
      }
    }
    case "resources/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: resources.map(({ read: _r, ...r }) => r),
        },
      };
    case "resources/templates/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resourceTemplates: resources.map(({ read: _r, uri, name, title, ...r }) => ({
            ...r,
            uriTemplate: uri.replace("org://", "org://{org_id}/"),
            name: `${name}-by-org`,
            title: title ? `${title} (any organization)` : undefined,
          })),
        },
      };
    case "resources/read": {
      const asked = String(params.uri ?? "");
      const target = parseResourceUri(asked);
      const r = resources.find((x) => x.uri === target.uri);
      if (!r) return rpcError(id, -32002, `Resource not found: ${asked}`);
      let scope: OrgScope;
      try {
        scope = await conn.scope(target.orgId);
      } catch (e) {
        if (e instanceof ApiError) return rpcError(id, -32002, e.message);
        throw e;
      }
      const text = await r.read({ ctx: conn.ctx, conn, scope });
      return { jsonrpc: "2.0", id, result: { contents: [{ uri: asked, mimeType: r.mimeType, text }] } };
    }
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    case "logging/setLevel":
      return { jsonrpc: "2.0", id, result: {} };
    default:
      return rpcError(id, -32601, `Method not found: ${String(msg.method)}`);
  }
}

registerMcpResource({
  uri: "org://profile",
  name: "profile",
  title: "Business profile",
  description:
    "What the business does, how it bills, typical customers and vendors, and which accounts to use for recurring items. Read this first. org://profile is the default organization; org://{org_id}/profile reads another one this connection covers.",
  mimeType: "text/markdown",
  read: orgProfileMarkdown,
});

registerMcpResource({
  uri: "org://notes",
  name: "notes",
  title: "Bookkeeping notes",
  description:
    "Dated, attributed notes on how this business books things, newest first. Add to them with append_note. org://notes is the default organization; org://{org_id}/notes reads another one this connection covers.",
  mimeType: "text/markdown",
  read: orgNotesMarkdown,
});

export function mountMcp(app: OpenAPIHono<AppEnv>, ctx: AppContext) {
  const publicOrigin = new URL(ctx.config.server.public_url).origin;

  app.on(["GET", "DELETE"], "/mcp", (c) => {
    c.header("allow", "POST");
    return c.json(
      { error: { code: "method_not_allowed", message: "This server is stateless: POST JSON-RPC messages." } },
      405,
    );
  });

  app.post("/mcp", async (c) => {
    // DNS-rebinding protection (MCP transport spec): browsers must come from our own origin.
    const origin = c.req.header("origin");
    if (origin && origin !== publicOrigin)
      return c.json({ error: { code: "forbidden_origin", message: "Origin not allowed." } }, 403);
    const version = c.req.header("mcp-protocol-version");
    if (version && !MCP_PROTOCOL_VERSIONS.includes(version))
      return c.json(
        {
          error: {
            code: "unsupported_protocol_version",
            message: `Supported: ${MCP_PROTOCOL_VERSIONS.join(", ")}`,
          },
        },
        400,
      );

    const auth = c.req.header("authorization");
    if (!auth?.toLowerCase().startsWith("bearer ")) return challenge(c, ctx);
    const ip = clientIp(c);
    const p = await principalFor(ctx, auth.slice(7).trim());
    if (!p) return challenge(c, ctx, "invalid_token", "The access token is invalid, expired, or revoked.");
    const conn = await connectionFor(ctx, p, ip);
    if (!conn)
      return challenge(
        c,
        ctx,
        "invalid_token",
        "The token's organizations are no longer available to this user.",
      );

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, "Parse error"), 400);
    }
    const batch = Array.isArray(body);
    const msgs = (batch ? body : [body]) as JsonRpc[];
    const out = [];
    for (const m of msgs) {
      if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") {
        out.push(rpcError(null, -32600, "Invalid request"));
        continue;
      }
      if (m.id === undefined || m.id === null) continue; // notification or response: nothing to answer
      try {
        out.push(await handle(conn, m));
      } catch (e) {
        ctx.logger.error("mcp error", { err: e, method: m.method, request_id: c.get("requestId") });
        out.push(rpcError(m.id, -32603, "Internal error"));
      }
    }
    if (!out.length) return c.body(null, 202);
    return c.json(batch ? out : out[0]!, 200);
  });
}
