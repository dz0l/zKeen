import { useCallback, useEffect, useState } from "react";
import { useApiError } from "./errors";
import { useT } from "./i18n";
import {
  fetchMihomoConfig,
  getSubscriptionHwid,
  getSubscriptionUrl,
  saveMihomoConfig,
  updateSubscriptionProvider,
} from "./config";

export function useMihomoConfig() {
  const t = useT();
  const apiErr = useApiError();
  const [configPath, setConfigPath] = useState("");
  const [yaml, setYaml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchMihomoConfig();
      if (!data) {
        setError(t("config.notFound"));
        setConfigPath("");
        setYaml("");
      } else {
        setConfigPath(data.path);
        setYaml(data.content);
        setDirty(false);
      }
    } catch (err) {
      setError(apiErr(err, "config.notFound"));
    } finally {
      setLoading(false);
    }
  }, [t, apiErr]);

  useEffect(() => {
    load();
  }, [load]);

  const updateYaml = useCallback((value: string) => {
    setYaml(value);
    setDirty(true);
  }, []);

  const save = useCallback(
    async (validate: boolean) => {
      if (!configPath) throw new Error("config not found");
      await saveMihomoConfig(configPath, yaml, validate);
      setDirty(false);
    },
    [configPath, yaml],
  );

  const subscriptionUrl = getSubscriptionUrl(yaml);
  const subscriptionHwid = getSubscriptionHwid(yaml);

  const updateSubscriptionUrl = useCallback((url: string) => {
    setYaml((prev) => updateSubscriptionProvider(prev, { url }));
    setDirty(true);
  }, []);

  const updateSubscriptionHwid = useCallback((hwid: string) => {
    setYaml((prev) => updateSubscriptionProvider(prev, { hwid }));
    setDirty(true);
  }, []);

  return {
    configPath,
    yaml,
    setYaml: updateYaml,
    loading,
    error,
    dirty,
    load,
    save,
    subscriptionUrl,
    subscriptionHwid,
    updateSubscriptionUrl,
    updateSubscriptionHwid,
  };
}
