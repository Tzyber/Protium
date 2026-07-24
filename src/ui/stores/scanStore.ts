import { defineStore } from "pinia";
import { getHome, tauriPorts } from "../../core/adapters/tauri";
import { discoverSteamRoot } from "../../core/paths";
import { scanLibrary } from "../../core/scan";
import { type ScanResult, SteamNotFoundError } from "../../core/types";
import { t } from "../i18n";

type Status = "idle" | "scanning" | "done" | "not-found" | "error";

interface State {
  status: Status;
  statusText: string;
  error: string | null;
  result: ScanResult | null;
  elapsedMs: number;
}

export const useScanStore = defineStore("scan", {
  state: (): State => ({
    status: "idle",
    statusText: t("status.ready"),
    error: null,
    result: null,
    elapsedMs: 0,
  }),
  getters: {
    games: (s) => s.result?.games ?? [],
    warnings: (s) => s.result?.warnings ?? [],
    compatTools: (s) => s.result?.compatToolsInstalled ?? [],
  },
  actions: {
    async runScan() {
      this.status = "scanning";
      this.error = null;
      const t0 = performance.now();
      try {
        this.statusText = t("status.findingSteam");
        const home = await getHome();
        const steamRoot = await discoverSteamRoot(tauriPorts.fs, home);
        this.statusText = t("status.scanningLibrary");
        this.result = await scanLibrary(tauriPorts, { home, steamRoot, protonDbDelayMs: 0 });
        this.status = "done";
        this.statusText = t("status.ready");
      } catch (e) {
        if (e instanceof SteamNotFoundError) {
          this.status = "not-found";
          this.statusText = t("status.noSteamInstallation");
        } else {
          this.status = "error";
          this.statusText = t("status.error");
          this.error = (e as Error)?.message ?? String(e);
          console.error("scan failed:", e);
        }
      } finally {
        this.elapsedMs = Math.round(performance.now() - t0);
      }
    },
  },
});
