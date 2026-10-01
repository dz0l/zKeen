import { useCallback, useEffect, useRef, useState } from "react";
import { useApiError } from "./errors";
import { useT } from "./i18n";
import type { ClashConnection } from "./api";
import {
  commitMihomoConfig,
  ConfigApplyError,
  fetchMihomoConfig,
  getSubscriptionHwid,
  getSubscriptionUrl,
  getSubscriptionUserAgent,
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

  /**
   * Save and apply exactly `content` (a snapshot taken by the caller); edits made meanwhile
   * stay dirty. If apply fails, the previous file is written back (see commitMihomoConfig).
   */
  const commit = useCallback(
    async (clash: ClashConnection, content: string, validate: boolean) => {
      if (!configPath) throw new Error("config not found");
      const markSaved = (text: string) => {
        setSavedYaml(text);
        setDirty(yamlRef.current !== text);
      };
      try {
        const res = await commitMihomoConfig(clash, {
          path: configPath,
          content,
          previous: savedYaml,
          validate,
        });
        markSaved(content);
        return res;
      } catch (err) {
        if (err instanceof ConfigApplyError && !err.rolledBack) markSaved(content);
        throw err;
      }
    },
    [configPath, savedYaml],
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
    commit,
    subscriptionUrl,
    subscriptionHwid,
    subscriptionUserAgent,
    updateSubscriptionUrl,
    updateSubscriptionHwid,
    updateSubscriptionUserAgent,
  };
}
