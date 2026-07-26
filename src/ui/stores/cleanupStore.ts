import { invoke } from "@tauri-apps/api/core";
import { defineStore } from "pinia";
import { tauriPorts } from "../../core/adapters/tauri";
import { findOrphans } from "../../core/cleanup";
import { readAllShortcutAppIds, SHORTCUT_ID_THRESHOLD } from "../../core/shortcuts";
import { findTrashEntries, type TrashEntry, type TrashLibraryStatus } from "../../core/trash";
import { type OrphanEntry } from "../../core/types";
import { errMsg } from "../format";
import { t } from "../i18n";
import { useScanStore } from "./scanStore";

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
    trash: [] as TrashEntry[],
    trashUnknown: [] as string[],
    trashUnreadable: [] as string[],
    trashLibraries: [] as TrashLibraryStatus[],
    trashSizes: {} as Record<string, number>,
    trashScanning: false,
    trashDeleting: null as string | null,
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
          this.error = t("errors.scanIncomplete", {
            paths: blocking.map((s) => s.path).join(", "),
          });
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
          this.error = t("errors.steamRunning");
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
            ? t("errors.userdataUnreadableWithDetail", { detail: this.shortcutUnreadableDetail })
            : t("errors.shortcutsUnreadable");
        }

        for (const o of this.orphans) {
          if (o.appId >= SHORTCUT_ID_THRESHOLD) o.potentialShortcut = true;
        }

        if (this.orphans.length === 0) return;

        const paths = this.orphans.map((o) => o.path);
        const sizes = await invoke<Record<string, number>>("batch_dir_sizes", { paths });
        for (const o of this.orphans) {
          // KEIN default auf 0: ein fehlender map-eintrag bedeutet, dass
          // batch_dir_sizes den pfad übersprungen hat (NotFound-race). das
          // sizeBytes bleibt dann undefined → UI rendert "…", ein leeres
          // verzeichnis (real 0 byte) rendert "—" via formatBytes. die 0
          // für summen/sort gehört in die rechner (?? 0 dort), nicht in
          // die anzeige.
          o.sizeBytes = sizes[o.path];
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
        this.error = t("errors.steamRunning");
        return;
      }

      // S-05: frischen installed-status bauen (games + shortcuts)
      const scan = useScanStore();
      const result = scan.result;
      if (!result) {
        this.error = t("errors.noScanResult");
        return;
      }

      const installedAppIds = new Set(result.games.map((g) => g.appId));

      const shortcutResult = await readAllShortcutAppIds(tauriPorts.fs, result.steamRoot);
      if (shortcutResult.status === "ok") {
        for (const id of shortcutResult.ids) installedAppIds.add(id);
      }

      const errors: string[] = [];
      // compatdata wird nicht gelöscht, sondern in den papierkorb VERSCHOBEN.
      // ohne refresh danach bliebe die papierkorb-sektion auf dem stand vom
      // öffnen der ansicht — der nutzer sieht "leer" und glaubt, die daten seien
      // weg, obwohl sie noch platz belegen.
      let trashedCompatdata = false;
      for (const entry of entries) {
        if (shortcutResult.status === "unreadable" && entry.type === "compatdata") {
          errors.push(
            t("errors.errorShortcutUnreadable", { type: entry.type, appId: entry.appId }),
          );
          continue;
        }
        if (installedAppIds.has(entry.appId)) {
          errors.push(t("errors.errorNowInstalled", { type: entry.type, appId: entry.appId }));
          continue;
        }

        const k = this.key(entry);
        this.deleting.add(k);
        try {
          await invoke<string>("remove_orphan_dir", { path: entry.path });
          this.orphans = this.orphans.filter((o) => this.key(o) !== k);
          // shadercache wird hart gelöscht und landet nie im papierkorb
          if (entry.type === "compatdata") trashedCompatdata = true;
        } catch (e) {
          errors.push(`${entry.type}/${entry.appId}: ${errMsg(e)}`);
        } finally {
          this.deleting.delete(k);
        }
      }
      // reihenfolge: erst refresh, dann fehler setzen. scanTrash() setzt
      // this.error zurück (es ist auch eine nutzer-aktion) und würde die
      // löschfehler sonst verschlucken.
      if (trashedCompatdata) await this.scanTrash();
      if (errors.length) {
        this.error = [this.error, errors.join("; ")].filter(Boolean).join(" | ");
      }
    },

    dismissPathMissing() {
      this.pathMissingDismissed = true;
      this.scanOrphans();
    },

    async scanTrash() {
      const scan = useScanStore();
      const result = scan.result;
      if (!result) {
        this.error = t("errors.noScanResult");
        return;
      }

      this.trashScanning = true;
      this.error = null;

      try {
        const { entries, unknown, unreadable, libraries } = await findTrashEntries(
          result.libraries,
          tauriPorts.system,
        );
        this.trash = entries;
        this.trashUnknown = unknown;
        this.trashUnreadable = unreadable;
        this.trashLibraries = libraries;

        // ein nicht lesbarer papierkorb darf nicht als "leer" durchgehen
        if (unreadable.length) {
          this.error = t("cleanup.trashUnreadable", { paths: unreadable.join(", ") });
        }

        if (entries.length === 0) return;

        const paths = entries.map((e) => e.path);
        const sizes = await invoke<Record<string, number>>("batch_dir_sizes", { paths });
        this.trashSizes = sizes;
        for (const e of this.trash) {
          e.sizeBytes = sizes[e.path];
        }
      } catch (e) {
        this.error = errMsg(e);
      } finally {
        this.trashScanning = false;
      }
    },

    async deleteTrashEntry(entry: TrashEntry) {
      this.trashDeleting = entry.path;
      try {
        await invoke<string>("remove_trash_entry", { path: entry.path });
        this.trash = this.trash.filter((e) => e.path !== entry.path);
      } catch (e) {
        this.error = `${entry.name}: ${errMsg(e)}`;
      } finally {
        this.trashDeleting = null;
      }
    },

    async emptyTrash() {
      const errors: string[] = [];
      for (const entry of [...this.trash]) {
        this.trashDeleting = entry.path;
        try {
          await invoke<string>("remove_trash_entry", { path: entry.path });
          this.trash = this.trash.filter((e) => e.path !== entry.path);
        } catch (e) {
          errors.push(`${entry.name}: ${errMsg(e)}`);
        } finally {
          this.trashDeleting = null;
        }
      }
      if (errors.length) this.error = errors.join("; ");
    },
  },
});
