import { defineStore } from "pinia";
import { appCacheDir, tauriPorts } from "../../core/adapters/tauri";
import { writeLaunchOptions } from "../../core/localconfig";
import { useScanStore } from "./scanStore";

// phase-4-writes: einziger weg von der UI in die steam-dateien (write-gate lebt im core).
export const useConfigStore = defineStore("config", {
  actions: {
    /** wirft (z. B. SteamRunningError) — der drawer zeigt die meldung an. */
    async saveLaunchOptions(appId: number, value: string): Promise<"unchanged" | "written"> {
      const result = useScanStore().result;
      if (!result) throw new Error("kein scan — bitte zuerst die library scannen.");
      if (!result.steamUserId) {
        throw new Error("kein steam-account gefunden — schreiben nicht möglich.");
      }
      const backupDir = `${await appCacheDir()}/backups`;
      const r = await writeLaunchOptions(
        tauriPorts,
        result.steamRoot,
        result.steamUserId,
        appId,
        value,
        backupDir,
      );
      // scan-result mitziehen, damit karte + drawer synchron bleiben
      const game = result.games.find((g) => g.appId === appId);
      if (game) game.launchOptions = value;
      return r;
    },
  },
});
