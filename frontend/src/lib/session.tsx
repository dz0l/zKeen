import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  apiJson,
  loadClashConnection,
  parseClashFromYaml,
  saveClashConnection,
  type ClashConnection,
} from "./api";

export interface LoginInfo {
  enabled: boolean;
  has_password: boolean;
  authenticated: boolean;
}

export interface ControlInfo {
  cores: string[];
  currentCore: string;
  running: boolean;
}

export interface ClashApiSettings {
  ping_url: string;
  ping_timeout: number;
  show_source_name: boolean;
  hide_unavailable_proxies: boolean;
  hide_unavailable_proxies_counter: number;
  proxy_sort_order: string;
}

export interface AppSettings {
  gui: { routing: boolean; log: boolean; auto_apply: boolean };
  updater: Record<string, unknown>;
  log: { timezone: number };
  clash_api: ClashApiSettings;
  auth: { enabled: boolean };
}

export interface VersionInfo {
  "zkeen-ui"?: { version: string; outdated?: boolean };
  xray?: { version: string };
  mihomo?: { version: string };
}

interface SessionState {
  booting: boolean;
  loginInfo: LoginInfo | null;
  settings: AppSettings | null;
  control: ControlInfo | null;
  versions: VersionInfo | null;
  clash: ClashConnection;
  setClash: (conn: ClashConnection) => void;
  refreshSession: () => Promise<void>;
  login: (password: string) => Promise<void>;
  setup: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

async function detectClashFromConfig(): Promise<ClashConnection | null> {
  try {
    const res = await apiJson<{ configs: { file: string; content: string }[] }>("/api/configs?core=mihomo");
    const main =
      res.configs?.find((c) => /(^|\/)config\.ya?ml$/i.test(c.file)) ?? res.configs?.[0];
    if (!main) return null;
    const parsed = parseClashFromYaml(main.content);
    if (!parsed.port && !parsed.unix) return null;
    const merged: ClashConnection = { port: "9090", secret: "", unix: "", ...parsed };
    saveClashConnection(merged);
    return merged;
  } catch {
    return null;
  }
}

async function loadAuthenticatedData(
  setSettings: (s: AppSettings | null) => void,
  setControl: (c: ControlInfo | null) => void,
  setVersions: (v: VersionInfo | null) => void,
  setClash: (c: ClashConnection) => void,
) {
  const [settingsRes, controlRes, versionRes] = await Promise.all([
    apiJson<AppSettings & { success: boolean }>("/api/settings"),
    apiJson<ControlInfo & { success: boolean }>("/api/control"),
    apiJson<VersionInfo & { success: boolean }>("/api/version"),
  ]);

  setSettings({
    gui: settingsRes.gui,
    updater: settingsRes.updater,
    log: settingsRes.log,
    clash_api: settingsRes.clash_api,
    auth: settingsRes.auth,
  });
  setControl({
    cores: controlRes.cores,
    currentCore: controlRes.currentCore,
    running: controlRes.running,
  });
  setVersions(versionRes);

  const saved = loadClashConnection();
  const detected = await detectClashFromConfig();
  const merged = detected
    ? {
        port: detected.port || saved.port || "9090",
        secret: detected.secret ?? saved.secret ?? "",
        unix: detected.unix ?? saved.unix ?? "",
      }
    : saved;
  saveClashConnection(merged);
  setClash(merged);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [booting, setBooting] = useState(true);
  const [loginInfo, setLoginInfo] = useState<LoginInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [control, setControl] = useState<ControlInfo | null>(null);
  const [versions, setVersions] = useState<VersionInfo | null>(null);
  const [clash, setClashState] = useState<ClashConnection>(loadClashConnection);

  const setClash = useCallback((conn: ClashConnection) => {
    saveClashConnection(conn);
    setClashState(conn);
  }, []);

  const refreshSession = useCallback(async () => {
    const info = await apiJson<LoginInfo>("/api/auth/login");
    setLoginInfo(info);

    const needsAuth = info.enabled && !info.authenticated;
    if (needsAuth) {
      setSettings(null);
      setControl(null);
      setVersions(null);
      return;
    }

    await loadAuthenticatedData(setSettings, setControl, setVersions, setClash);
  }, [setClash]);

  useEffect(() => {
    refreshSession()
      .catch(() => {
        setLoginInfo({ enabled: false, has_password: false, authenticated: true });
      })
      .finally(() => setBooting(false));
  }, [refreshSession]);

  const login = useCallback(
    async (password: string) => {
      await apiJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ password, remember: true }),
      });
      await refreshSession();
    },
    [refreshSession],
  );

  const setup = useCallback(
    async (password: string) => {
      await apiJson("/api/auth/setup", {
        method: "POST",
        body: JSON.stringify({ password, remember: true }),
      });
      await refreshSession();
    },
    [refreshSession],
  );

  const logout = useCallback(async () => {
    await apiJson("/api/auth/logout", { method: "POST" });
    await refreshSession();
  }, [refreshSession]);

  const value = useMemo(
    () => ({
      booting,
      loginInfo,
      settings,
      control,
      versions,
      clash,
      setClash,
      refreshSession,
      login,
      setup,
      logout,
    }),
    [
      booting,
      loginInfo,
      settings,
      control,
      versions,
      clash,
      setClash,
      refreshSession,
      login,
      setup,
      logout,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}

export function useNeedsAuth(): boolean {
  const { loginInfo, booting } = useSession();
  if (booting || !loginInfo) return false;
  return loginInfo.enabled && !loginInfo.authenticated;
}
