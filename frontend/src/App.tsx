import type { ComponentType } from "react";
import { AppProvider, useApp } from "./lib/store";
import { SessionProvider } from "./lib/session";
import { AuthGate } from "./components/AuthGate";
import { OnboardingGate } from "./components/OnboardingGate";
import { AppShell } from "./components/layout";
import { StatusPage } from "./pages/StatusPage";
import { ProxiesPage } from "./pages/ProxiesPage";
import { ConfigPage } from "./pages/ConfigPage";
import { GroupsPage } from "./pages/GroupsPage";
import { PoliciesPage } from "./pages/PoliciesPage";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { PageId } from "./lib/types";

const PAGES: Record<PageId, ComponentType> = {
  status: StatusPage,
  connections: ConnectionsPage,
  proxies: ProxiesPage,
  config: ConfigPage,
  groups: GroupsPage,
  policies: PoliciesPage,
  settings: SettingsPage,
};

function Router() {
  const { page } = useApp();
  const Page = PAGES[page];
  return <Page />;
}

export default function App() {
  return (
    <AppProvider>
      <SessionProvider>
        <AuthGate>
          <OnboardingGate>
            <AppShell>
              <Router />
            </AppShell>
          </OnboardingGate>
        </AuthGate>
      </SessionProvider>
    </AppProvider>
  );
}
