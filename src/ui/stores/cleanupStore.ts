import { invoke } from "@tauri-apps/api/core";
import { defineStore } from "pinia";
import { tauriPorts } from "../../core/adapters/tauri";
import { findOrphans } from "../../core/cleanup";
import { SteamRunningError } from "../../core/configwrite";
import { readAllShortcutAppIds, SHORTCUT_ID_THRESHOLD } from "../../core/shortcuts";
import { type OrphanEntry, type SkippedLibrary } from "../../core/types";
import { useScanStore } from "./scanStore";

function errMsg(e: unknown): string {
  return typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
}

export const useCleanupStore = defineStore("cleanup", {
  state: () => ({
    orphans: [] as OrphanEntry[],
    scanning: false,
    deleting: new Set<string>(),
    error: null as string | null,
    blockedBySkipped: false,
    pathMissingLibs: [] as string[],
    pathMissingDismissed: false,
    shortcutUnreadable: false,
    shortcutUnreadablePaths: [] as string[],
    shortcutUnreadableDetail: null as string | null,
  }),
  getters: {
    compatdataOrphans: (s) => s.orphans.filter((o) => o.type === "compatdata"),
    shadercacheOrphans: (s) => s.orphans.filter((o) => o.type === "shadercache"),
    totalOrphanBytes: (s) => s.orphans.reduce((sum, o) => sum + (o.sizeBytes ?? 0), 0),
  },
  actions: {
    key(entry: OrphanEntry): string {
      return `${entry.type}:${entry.appId}`;
    },

    async scanOrphans() {
      const scan = useScanStore();
      const result = scan.result;
      if (!result) return;

      this.scanning = true;
      this.error = null;

      try {
        const skipped = result.skippedLibraries;
        const blocking = skipped.filter((s) => s.reason !== "path-missing");
        if (blocking.length > 0) {
          this.blockedBySkipped = true;
          this.error = `Scan unvollständig — Libraries übersprungen: ${blocking.map((s) => s.path).join(", ")}`;
          return;
        }
        this.blockedBySkipped = false;

        const missing = skipped.filter((s) => s.reason === "path-missing");
        if (missing.length > 0 && !this.pathMissingDismissed) {
          this.pathMissingLibs = missing.map((s) => s.path);
          return;
        }
        this.pathMissingLibs = [];
        this.pathMissingDismissed = false;

        if (await tauriPorts.system.isProcessRunning("steam")) {
          this.error = new SteamRunningError().message;
          return;
        }

        const shortcutResult = await readAllShortcutAppIds(tauriPorts.fs, result.steamRoot);
        if (shortcutResult.status === "unreadable") {
          this.shortcutUnreadable = true;
          this.shortcutUnreadablePaths = shortcutResult.paths;
          this.shortcutUnreadableDetail = shortcutResult.detail ?? null;
        } else {
          this.shortcutUnreadable = false;
          this.shortcutUnreadablePaths = [];
          this.shortcutUnreadableDetail = null;
        }

        const installedAppIds = new Set(result.games.map((g) => g.appId));
        if (shortcutResult.status === "ok") {
          for (const id of shortcutResult.ids) installedAppIds.add(id);
        }

        this.orphans = await findOrphans(result.libraries, installedAppIds, tauriPorts.fs);

        if (this.shortcutUnreadable) {
          // WHY fail-closed: unlesbares shortcuts.vdf → Non-Steam-Shortcuts sind nicht
          // von echten Orphans unterscheidbar. compatdata kann echte Savegames enthalten,
          // deshalb blockieren. shadercache ist regenerierbar und darf bereinigt werden.
          this.orphans = this.orphans.filter((o) => o.type === "shadercache");
          this.error = this.shortcutUnreadableDetail
            ? `userdata nicht lesbar — Wine-Prefix-Bereinigung deaktiviert: ${this.shortcutUnreadableDetail}`
            : "shortcuts.vdf nicht lesbar — Wine-Prefix-Bereinigung deaktiviert.";
        }

        for (const o of this.orphans) {
          if (o.appId >= SHORTCUT_ID_THRESHOLD) o.potentialShortcut = true;
        }

        if (this.orphans.length === 0) return;

        const paths = this.orphans.map((o) => o.path);
        const sizes = await invoke<Record<string, number>>("batch_dir_sizes", { paths });
        for (const o of this.orphans) {
          o.sizeBytes = sizes[o.path] ?? 0;
        }
      } catch (e) {
        this.error = errMsg(e);
      } finally {
        this.scanning = false;
      }
    },

    async deleteOrphans(entries: OrphanEntry[]) {
      if (this.blockedBySkipped) return;
      if (await tauriPorts.system.isProcessRunning("steam")) {
        this.error = new SteamRunningError().message;
        return;
      }

      // S-05: frischen installed-status bauen (games + shortcuts)
      const scan = useScanStore();
      const result = scan.result;
      const installedAppIds = new Set(result?.games.map((g) => g.appId) ?? []);

      const shortcutResult = result
        ? await readAllShortcutAppIds(tauriPorts.fs, result.steamRoot)
        : null;
      if (shortcutResult?.status === "ok") {
        for (const id of shortcutResult.ids) installedAppIds.add(id);
      }

      const errors: string[] = [];
      for (const entry of entries) {
        if (shortcutResult?.status === "unreadable" && entry.type === "compatdata") {
          errors.push(`${entry.type}/${entry.appId}: shortcuts.vdf nicht lesbar — übersprungen`);
          continue;
        }
        if (installedAppIds.has(entry.appId)) {
          errors.push(`${entry.type}/${entry.appId}: inzwischen installiert — übersprungen`);
          continue;
        }

        const k = this.key(entry);
        this.deleting.add(k);
        try {
          await invoke<string>("remove_orphan_dir", { path: entry.path });
          this.orphans = this.orphans.filter((o) => this.key(o) !== k);
        } catch (e) {
          errors.push(`${entry.type}/${entry.appId}: ${errMsg(e)}`);
        } finally {
          this.deleting.delete(k);
        }
      }
      if (errors.length) this.error = errors.join("; ");
    },

    dismissPathMissing() {
      this.pathMissingDismissed = true;
      this.scanOrphans();
    },
  },
});
