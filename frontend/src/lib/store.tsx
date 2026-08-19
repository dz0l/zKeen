import { createContext, useContext, useState, type ReactNode } from "react";
import type { AppMode, PageId } from "./types";

interface AppState {
  page: PageId;
  setPage: (page: PageId) => void;
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<PageId>("status");
  const [mode, setMode] = useState<AppMode>("safe");
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <AppContext.Provider value={{ page, setPage, mode, setMode, menuOpen, setMenuOpen }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside provider");
  return ctx;
}
