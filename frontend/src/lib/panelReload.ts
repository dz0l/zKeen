/** After panel binary/port restart: wait until API is up, then hard-navigate (bypass SPA + asset cache). */

function panelOrigin(port?: number | string): string {
  const { protocol, hostname } = window.location;
  const p = port !== undefined && port !== "" ? String(port) : window.location.port || "7220";
  return `${protocol}//${hostname}:${p}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll until the panel answers, then replace location with a cache-busting URL.
 * Needed after self-update / port change / restartPanel — otherwise the old SPA stays in memory.
 */
export async function waitForPanelAndHardReload(opts?: {
  port?: number | string;
  /** Give the process a moment to die before polling. */
  initialDelayMs?: number;
  attempts?: number;
  delayMs?: number;
}): Promise<void> {
  const origin = panelOrigin(opts?.port);
  const attempts = opts?.attempts ?? 60;
  const delayMs = opts?.delayMs ?? 500;
  await sleep(opts?.initialDelayMs ?? 800);

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${origin}/api/version?_=${Date.now()}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (res.ok) {
        window.location.replace(`${origin}/?_=${Date.now()}`);
        return;
      }
    } catch {
      /* still restarting */
    }
    await sleep(delayMs);
  }

  // Last resort: navigate anyway (user can refresh if still down).
  window.location.replace(`${origin}/?_=${Date.now()}`);
}
