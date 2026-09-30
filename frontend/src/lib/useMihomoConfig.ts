import { useCallback, useEffect, useRef, useState } from "react";
import { useApiError } from "./errors";
import { useT } from "./i18n";
import {
  fetchMihomoConfig,
  getSubscriptionHwid,
  getSubscriptionUrl,
  getSubscriptionUserAgent,
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
  /** Content known to be on disk (last load or successful save). */
  const [savedYaml, setSavedYaml] = useState("");
  const yamlRef = useRef(yaml);
  yamlRef.current = yaml;

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
        setSavedYaml(data.content);
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

  /** Save exactly `content` (a snapshot taken by the caller); edits made meanwhile stay dirty. */
  const save = useCallback(
    async (content: string, validate: boolean) => {
      if (!configPath) throw new Error("config not found");
      const res = await saveMihomoConfig(configPath, content, validate);
      setSavedYaml(content);
      setDirty(yamlRef.current !== content);
      return res;
    },
    [configPath],
  );

  const subscriptionUrl = getSubscriptionUrl(yaml);
  const subscriptionHwid = getSubscriptionHwid(yaml);
  const subscriptionUserAgent = getSubscriptionUserAgent(yaml);

  const updateSubscriptionUrl = useCallback((url: string) => {
    setYaml((prev) => updateSubscriptionProvider(prev, { url }));
    setDirty(true);
  }, []);

  const updateSubscriptionHwid = useCallback((hwid: string) => {
    setYaml((prev) => updateSubscriptionProvider(prev, { hwid }));
    setDirty(true);
  }, []);

  const updateSubscriptionUserAgent = useCallback((userAgent: string) => {
    setYaml((prev) => updateSubscriptionProvider(prev, { userAgent }));
    setDirty(true);
  }, []);

  return {
    configPath,
    yaml,
    setYaml: updateYaml,
    loading,
    error,
    dirty,
    savedYaml,
    load,
    save,
    subscriptionUrl,
    subscriptionHwid,
    subscriptionUserAgent,
    updateSubscriptionUrl,
    updateSubscriptionHwid,
    updateSubscriptionUserAgent,
  };
}
