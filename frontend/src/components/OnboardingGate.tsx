import { useEffect, useState, type FormEvent } from "react";
import { Button, Card, CardHeader, Input } from "./ui";
import { useApiError } from "../lib/errors";
import {
  applySubscriptionUrl,
  clearLegacyOnboardingFlag,
  clearOnboardingSessionSkip,
  fetchMihomoConfig,
  getSubscriptionUrl,
  isOnboardingSkippedThisSession,
  skipOnboardingThisSession,
} from "../lib/config";
import { useSession } from "../lib/session";
import { useT } from "../lib/i18n";

export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const t = useT();
  const apiErr = useApiError();
  const { booting, clash, setClash, refreshSession } = useSession();
  const [checking, setChecking] = useState(true);
  const [needSetup, setNeedSetup] = useState(false);
  const [url, setUrl] = useState("");
  const [hwid, setHwid] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (booting) return;
    let cancelled = false;

    (async () => {
      clearLegacyOnboardingFlag();
      try {
        const loaded = await fetchMihomoConfig();
        const subUrl = loaded ? getSubscriptionUrl(loaded.content).trim() : "";
        if (cancelled) return;
        // Show welcome when config has no subscription URL (unless skipped this tab session).
        setNeedSetup(!subUrl && !isOnboardingSkippedThisSession());
      } catch {
        if (!cancelled) {
          setNeedSetup(!isOnboardingSkippedThisSession());
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [booting]);

  if (booting || checking || !needSetup) {
    return children;
  }

  async function finish(skipUrl: boolean) {
    setLoading(true);
    setError("");
    try {
      if (!skipUrl && url.trim()) {
        const result = await applySubscriptionUrl(url.trim(), clash, hwid.trim());
        setClash(result.clash);
        clearOnboardingSessionSkip();
      } else {
        skipOnboardingThisSession();
      }
      await refreshSession();
      setNeedSetup(false);
    } catch (err) {
      setError(apiErr(err, "onboarding.failed"));
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void finish(false);
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-zk-bg/95 p-4 backdrop-blur-sm">
      <Card className="w-full max-w-lg">
        <CardHeader
          title={t("onboarding.title")}
          subtitle={t("onboarding.subtitle")}
        />
        <form onSubmit={onSubmit} className="space-y-4 p-4 sm:p-5">
          <p className="text-sm text-zk-muted">{t("onboarding.hint")}</p>
          <Input
            label={t("onboarding.subUrl")}
            placeholder="https://..."
            mono
            value={url}
            onChange={setUrl}
            hint={t("onboarding.subHint")}
          />
          <Input
            label={t("config.qHwid")}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            mono
            value={hwid}
            onChange={setHwid}
          />
          {error && (
            <p className="rounded-lg border border-zk-coral/25 bg-zk-coral/10 px-3 py-2 text-xs text-zk-coral">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              disabled={loading}
              onClick={() => void finish(true)}
            >
              {t("onboarding.skip")}
            </Button>
            <Button type="submit" variant="primary" disabled={loading || !url.trim()}>
              {loading ? t("app.loading") : t("onboarding.continue")}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
