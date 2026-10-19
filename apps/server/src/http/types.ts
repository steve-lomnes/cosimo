import type { Role } from "@cosimo/shared";
import type { AppContext } from "../context.ts";
import type { ActorInfo } from "../services/actor.ts";
import type { OrgHandle } from "../services/types.ts";

export interface Principal {
  kind: "session" | "api_token" | "oauth";
  userId: string;
  email: string;
  name: string;
  isInstanceAdmin: boolean;
  sessionTokenHash?: string;
  apiTokenId?: string;
  oauthTokenId?: string;
  oauthClientId?: string;
  /** API tokens are scoped to one org and capped at a role. */
  orgId?: string;
  roleCap?: Role;
  /**
   * OAuth connections cover a set of orgs, each capped at its own role. Only orgs in this list are
   * reachable; `defaultOrgId` is the one MCP tools use when a call names none.
   */
  orgGrants?: OrgGrant[];
  defaultOrgId?: string | null;
  proposeOnly?: boolean;
}

export interface OrgGrant {
  orgId: string;
  roleCap: Role;
}

export interface OrgScope {
  id: string;
  handle: OrgHandle;
  role: Role;
  actor: ActorInfo;
}

export interface AppEnv {
  Variables: {
    ctx: AppContext;
    requestId: string;
    principal: Principal | null;
    org: OrgScope;
    ip: string;
  };
}
