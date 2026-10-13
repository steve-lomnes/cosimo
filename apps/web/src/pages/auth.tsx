import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ApiError, api, unwrap } from "../api/client";
import { Alert, Button, Card, ErrorText, Field, Input, Loading } from "../components/ui";
import { useRefreshSession, useSession } from "../lib/session";
import { safeNext } from "./connect";

function AuthFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <img src="/favicon.svg" alt="" className="h-8 w-8" />
          <span className="text-lg font-semibold tracking-tight">Cosimo</span>
        </div>
        <Card>
          <h1 className="mb-4 text-lg font-semibold">{title}</h1>
          {children}
        </Card>
      </div>
    </div>
  );
}

/** The `?next=` query to carry between the login and sign-up pages. */
function nextSearch(): { next?: string } {
  const next = new URLSearchParams(window.location.search).get("next");
  return next ? { next } : {};
}

export function LoginPage() {
  const session = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useRefreshSession();
  const navigate = useNavigate();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/api/v1/auth/login", { body: { email, password, totp_code: needTotp ? totp : undefined } }),
      );
      await refresh();
      const next = safeNext(new URLSearchParams(window.location.search).get("next"));
      if (next !== "/") window.location.assign(next);
      else navigate({ to: "/" });
    } catch (err) {
      if (err instanceof ApiError && err.code === "totp_required") setNeedTotp(true);
      else setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame title="Sign in">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          {(id) => (
            <Input
              id={id}
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field label="Password">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        {needTotp && (
          <Field label="Two-factor code" hint="6-digit code from your authenticator app, or a recovery code.">
            {(id) => (
              <Input
                id={id}
                autoComplete="one-time-code"
                autoFocus
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
              />
            )}
          </Field>
        )}
        <ErrorText error={error} />
        <Button type="submit" loading={busy} className="w-full">
          Sign in
        </Button>
        {session.data?.instance.signup_mode === "open" && (
          <p className="text-center text-sm text-zinc-500">
            No account?{" "}
            <Link to="/signup" search={nextSearch()} className="underline">
              Create one
            </Link>
          </p>
        )}
      </form>
    </AuthFrame>
  );
}

export function SignupPage() {
  const session = useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useRefreshSession();
  const navigate = useNavigate();
  if (session.isLoading) return <Loading />;
  if (session.data?.instance.signup_mode !== "open") {
    return (
      <AuthFrame title="Sign-up is closed">
        <Alert>This instance doesn't accept public sign-ups. Ask an administrator for an invitation.</Alert>
        <p className="mt-4 text-center text-sm text-zinc-500">
          <Link to="/login" search={nextSearch()} className="underline">
            Sign in
          </Link>
        </p>
      </AuthFrame>
    );
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError(new Error("Passwords do not match."));
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/api/v1/auth/signup", { body: { email, password, name } }));
      await refresh();
      const next = safeNext(new URLSearchParams(window.location.search).get("next"));
      if (next !== "/") window.location.assign(next);
      else navigate({ to: "/" });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame title="Create your account">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          {(id) => (
            <Input
              id={id}
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="Email">
          {(id) => (
            <Input
              id={id}
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Field label="Confirm password">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
        </Field>
        <ErrorText error={error} />
        <Button type="submit" loading={busy} className="w-full">
          Create account
        </Button>
        <p className="text-center text-sm text-zinc-500">
          Already have an account?{" "}
          <Link to="/login" search={nextSearch()} className="underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthFrame>
  );
}

export function ClaimPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const info = useQuery({
    queryKey: ["claim", token],
    queryFn: () => unwrap(api.GET("/api/v1/auth/claim/{token}", { params: { path: { token } } })),
    retry: false,
  });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useRefreshSession();
  const navigate = useNavigate();
  if (info.isLoading) return <Loading />;
  if (info.error) {
    return (
      <AuthFrame title="Link not valid">
        <Alert kind="error">{(info.error as Error).message}</Alert>
        <p className="mt-4 text-sm text-zinc-500">
          Ask your administrator for a new link, or run <code>cosimo user claim-link &lt;email&gt;</code>.
        </p>
      </AuthFrame>
    );
  }
  const reset = info.data?.purpose === "password_reset";
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError(new Error("Passwords do not match."));
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/api/v1/auth/claim", { body: { token, password, name: name || undefined } }));
      await refresh();
      navigate({ to: "/" });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame title={reset ? "Reset your password" : "Welcome to Cosimo"}>
      <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
        {reset ? "Choose a new password for" : "Set a password to finish setting up"}{" "}
        <strong>{info.data?.email}</strong>.
      </p>
      <form onSubmit={submit} className="space-y-4">
        {!reset && !info.data?.name && (
          <Field label="Your name">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
        )}
        <Field label="Password" hint="At least 10 characters.">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Field label="Confirm password">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
        </Field>
        <ErrorText error={error} />
        <Button type="submit" loading={busy} className="w-full">
          {reset ? "Set new password" : "Set password and continue"}
        </Button>
        <p className="text-xs text-zinc-500">
          You can turn on two-factor authentication under your account afterwards.
        </p>
      </form>
    </AuthFrame>
  );
}

export function InvitePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const info = useQuery({
    queryKey: ["invite", token],
    queryFn: () => unwrap(api.GET("/api/v1/invitations/{token}", { params: { path: { token } } })),
    retry: false,
  });
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useRefreshSession();
  const navigate = useNavigate();
  if (info.isLoading) return <Loading />;
  if (info.error) {
    return (
      <AuthFrame title="Invitation not valid">
        <Alert kind="error">{(info.error as Error).message}</Alert>
      </AuthFrame>
    );
  }
  const d = info.data!;
  async function accept(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await unwrap(
        api.POST("/api/v1/invitations/accept", {
          body: { token, password: d.user_exists ? undefined : password, name },
        }),
      );
      if (!d.user_exists) {
        await unwrap(api.POST("/api/v1/auth/login", { body: { email: d.email, password } }));
      }
      await refresh();
      navigate(res.org_id ? { to: "/o/$orgId", params: { orgId: res.org_id } } : { to: "/" });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame title="You're invited">
      <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
        {d.org_name ? (
          <>
            Join <strong>{d.org_name}</strong> as <strong>{d.role}</strong>.
          </>
        ) : (
          <>Create your account.</>
        )}
      </p>
      <form onSubmit={accept} className="space-y-4">
        {d.user_exists ? (
          <Alert>
            You already have an account ({d.email}).{" "}
            <Link to="/login" className="underline">
              Sign in
            </Link>{" "}
            first, then open this link again.
          </Alert>
        ) : (
          <>
            <Field label="Your name">
              {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Field label="Password" hint="At least 10 characters.">
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
            </Field>
          </>
        )}
        <ErrorText error={error} />
        <Button type="submit" loading={busy} className="w-full">
          Accept invitation
        </Button>
      </form>
    </AuthFrame>
  );
}
