import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Navigate,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { PlainShell, Shell } from "./components/Shell";
import { Loading } from "./components/ui";
import { useSession } from "./lib/session";
import { AccountPage } from "./pages/account";
import { AdminPage } from "./pages/admin";
import { ClaimPage, InvitePage, LoginPage, SignupPage } from "./pages/auth";
import { PlaidOAuthPage } from "./pages/bank-feeds";
import { ConnectPage } from "./pages/connect";
import { DashboardPage } from "./pages/dashboard";
import { OrgsPage } from "./pages/orgs";
import { SettingsPage } from "./pages/settings";
import { orgChildRoutes } from "./routes-org";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useSession();
  if (isLoading) return <Loading />;
  if (!data?.user) return <Navigate to="/login" />;
  return <>{children}</>;
}

function NotFound() {
  return (
    <PlainShell>
      <h1 className="text-lg font-semibold">Page not found</h1>
      <Link to="/" className="text-sm underline">
        Go home
      </Link>
    </PlainShell>
  );
}

const root = createRootRoute({ component: () => <Outlet />, notFoundComponent: NotFound });

const index = createRoute({
  getParentRoute: () => root,
  path: "/",
  component: function Home() {
    const { data, isLoading } = useSession();
    if (isLoading) return <Loading />;
    if (!data?.user) return <Navigate to="/login" />;
    const first = data.orgs.find((o) => !o.is_sample) ?? data.orgs[0];
    return first ? <Navigate to="/o/$orgId" params={{ orgId: first.id }} /> : <Navigate to="/orgs" />;
  },
});

const login = createRoute({ getParentRoute: () => root, path: "/login", component: LoginPage });
const signup = createRoute({ getParentRoute: () => root, path: "/signup", component: SignupPage });
const claim = createRoute({ getParentRoute: () => root, path: "/claim/$token", component: ClaimPage });
const invite = createRoute({ getParentRoute: () => root, path: "/invite/$token", component: InvitePage });
const orgs = createRoute({
  getParentRoute: () => root,
  path: "/orgs",
  component: () => (
    <RequireAuth>
      <OrgsPage />
    </RequireAuth>
  ),
});
const account = createRoute({
  getParentRoute: () => root,
  path: "/account",
  component: () => (
    <RequireAuth>
      <AccountPage />
    </RequireAuth>
  ),
});
const admin = createRoute({
  getParentRoute: () => root,
  path: "/admin",
  component: () => (
    <RequireAuth>
      <AdminPage />
    </RequireAuth>
  ),
});

const connect = createRoute({ getParentRoute: () => root, path: "/connect", component: ConnectPage });

const plaidOAuth = createRoute({
  getParentRoute: () => root,
  path: "/plaid/oauth",
  component: () => (
    <RequireAuth>
      <PlaidOAuthPage />
    </RequireAuth>
  ),
});

export const orgLayout = createRoute({
  getParentRoute: () => root,
  path: "/o/$orgId",
  component: function OrgLayout() {
    const { orgId } = useParams({ strict: false }) as { orgId: string };
    const { data, isLoading } = useSession();
    if (isLoading) return <Loading />;
    if (!data?.user) return <Navigate to="/login" />;
    if (!data.orgs.some((o) => o.id === orgId)) return <NotFound />;
    return (
      <Shell orgId={orgId}>
        <Outlet />
      </Shell>
    );
  },
});

const dashboard = createRoute({ getParentRoute: () => orgLayout, path: "/", component: DashboardPage });
const settings = createRoute({ getParentRoute: () => orgLayout, path: "/settings", component: SettingsPage });

const routeTree = root.addChildren([
  index,
  login,
  signup,
  claim,
  invite,
  orgs,
  account,
  admin,
  plaidOAuth,
  connect,
  orgLayout.addChildren([dashboard, settings, ...orgChildRoutes(orgLayout)]),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
