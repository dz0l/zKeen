import type { ReactNode } from "react";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { NAV_ITEMS, MOBILE_PRIMARY } from "../lib/types";
import { Badge, ModeToggle } from "./ui";
import { IconMenu, PAGE_ICONS } from "./icons";

export function Header() {
  const { mode, setMode } = useApp();

  return (
    <header className="sticky top-0 z-40 border-b border-zk-border-soft/80 bg-zk-bg/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold tracking-tight">
                z<span className="text-zk-accent">Keen</span>
              </span>
              <Badge variant="muted">ui</Badge>
            </div>
            <p className="hidden text-[11px] text-zk-dim sm:block">proxy control panel</p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <Badge variant={mode === "safe" ? "safe" : "expert"}>
            {mode === "safe" ? "🛡 Safe" : "⚡ Expert"}
          </Badge>
          <div className="hidden w-36 sm:block">
            <ModeToggle mode={mode} onChange={setMode} />
          </div>
        </div>
      </div>
    </header>
  );
}

export function SideNav() {
  const { page, setPage } = useApp();
  const t = useT();

  return (
    <nav className="hidden lg:flex lg:w-56 lg:flex-col lg:gap-1 lg:pr-4">
      <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-zk-dim">
        {t("nav.navigation")}
      </p>
      {NAV_ITEMS.map((item) => {
        const Icon = PAGE_ICONS[item.id];
        const active = page === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => setPage(item.id)}
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-all ${
              active
                ? "bg-zk-accent/10 text-zk-accent border border-zk-accent/20"
                : "text-zk-muted hover:bg-zk-surface hover:text-zk-text border border-transparent"
            }`}
          >
            <Icon className="h-5 w-5 shrink-0" active={active} />
            {t(item.labelKey)}
          </button>
        );
      })}
    </nav>
  );
}

export function BottomNav() {
  const { page, setPage, setMenuOpen } = useApp();
  const t = useT();

  return (
    <nav className="fixed bottom-0 inset-x-0 z-50 border-t border-zk-border-soft/80 bg-zk-bg/90 backdrop-blur-xl pb-[env(safe-area-inset-bottom)] lg:hidden">
      <div className="mx-auto flex max-w-lg items-stretch justify-around px-1 pt-1">
        {MOBILE_PRIMARY.map((id) => {
          const item = NAV_ITEMS.find((n) => n.id === id)!;
          const Icon = PAGE_ICONS[id];
          const active = page === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setPage(id)}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors ${
                active ? "text-zk-accent" : "text-zk-dim"
              }`}
            >
              <Icon className="h-5 w-5" active={active} />
              {t(item.shortLabelKey)}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors ${
            "text-zk-dim"
          }`}
        >
          <IconMenu className="h-5 w-5" />
          {t("nav.more")}
        </button>
      </div>
    </nav>
  );
}

export function MobileMenu() {
  const { page, setPage, menuOpen, setMenuOpen, mode, setMode } = useApp();
  const t = useT();

  if (!menuOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm lg:hidden"
        onClick={() => setMenuOpen(false)}
      />
      <div className="fixed inset-x-0 bottom-0 z-[70] rounded-t-3xl border border-zk-border-soft bg-zk-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] lg:hidden">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-semibold">{t("nav.sections")}</span>
          <button type="button" onClick={() => setMenuOpen(false)} className="rounded-lg p-2 text-zk-muted hover:bg-zk-surface-hover">
            ✕
          </button>
        </div>

        <div className="mb-4 sm:hidden">
          <p className="mb-2 text-xs text-zk-muted">{t("nav.workMode")}</p>
          <ModeToggle mode={mode} onChange={setMode} />
        </div>

        <div className="grid gap-1">
          {NAV_ITEMS.filter((n) => !MOBILE_PRIMARY.includes(n.id)).map((item) => {
            const Icon = PAGE_ICONS[item.id];
            const active = page === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setPage(item.id);
                  setMenuOpen(false);
                }}
                className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium ${
                  active ? "bg-zk-accent/10 text-zk-accent" : "text-zk-text hover:bg-zk-surface-hover"
                }`}
              >
                <Icon className="h-5 w-5" active={active} />
                {t(item.labelKey)}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-6 px-4 py-4 sm:px-6 lg:py-6">
        <SideNav />
        <main className="min-w-0 flex-1 pb-24 lg:pb-6">{children}</main>
      </div>
      <BottomNav />
      <MobileMenu />
    </div>
  );
}
