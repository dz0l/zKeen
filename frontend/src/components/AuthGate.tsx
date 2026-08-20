import { useState, type FormEvent } from "react";
import { Button, Card, CardHeader, Input } from "./ui";
import { useSession, useNeedsAuth } from "../lib/session";
import { useApiError } from "../lib/errors";
import { useT } from "../lib/i18n";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const t = useT();
  const apiErr = useApiError();
  const { booting, loginInfo } = useSession();
  const needsAuth = useNeedsAuth();
  const { login, setup } = useSession();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (booting) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-zk-bg">
        <p className="text-sm text-zk-muted">{t("app.loading")}</p>
      </div>
    );
  }

  if (!needsAuth) {
    return children;
  }

  const isSetup = !loginInfo?.has_password;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 4) {
      setError(t("auth.passwordShort"));
      return;
    }
    if (isSetup && password !== confirm) {
      setError(t("auth.passwordMismatch"));
      return;
    }
    setLoading(true);
    try {
      if (isSetup) await setup(password);
      else await login(password);
      setPassword("");
      setConfirm("");
    } catch (err) {
      setError(apiErr(err, "auth.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-zk-bg p-4">
      <Card className="w-full max-w-md">
        <CardHeader
          title={isSetup ? t("auth.setupTitle") : t("auth.loginTitle")}
          subtitle={isSetup ? t("auth.setupSub") : t("auth.loginSub")}
        />
        <form onSubmit={onSubmit} className="space-y-3 p-4 sm:p-5">
          <Input
            label={t("auth.password")}
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="••••••••"
          />
          {isSetup && (
            <Input
              label={t("auth.confirmPassword")}
              type="password"
              value={confirm}
              onChange={setConfirm}
              placeholder="••••••••"
            />
          )}
          {error && (
            <p className="rounded-lg border border-zk-coral/25 bg-zk-coral/10 px-3 py-2 text-xs text-zk-coral">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? t("app.loading") : isSetup ? t("auth.setupAction") : t("auth.loginAction")}
          </Button>
        </form>
      </Card>
    </div>
  );
}
