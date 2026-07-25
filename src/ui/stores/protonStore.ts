import { listen } from "@tauri-apps/api/event";
import { defineStore } from "pinia";
import { appCacheDir, tauriPorts } from "../../core/adapters/tauri";
import {
  type FetchSource,
  fetchReleases,
  type GeRelease,
  installRelease,
  removeTool,
} from "../../core/geproton";
import type { CompatTool } from "../../core/types";
import { t } from "../i18n";
import { useScanStore } from "./scanStore";

type Phase = "queued" | "downloading" | "verifying" | "extracting";

/** rust-commands rejecten mit einem rohen string (kein Error-objekt) → sicher auslesen. */
function errMsg(e: unknown): string {
  return typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
}

interface Job {
  tag: string;
  phase: Phase;
  downloaded: number;
  total: number | null;
  /** vom nutzer angefordert, solange der job noch existiert. lebt bewusst hier
   *  und nicht in der rust-registry: der store kennt den job-lebenszyklus, das
   *  backend nur laufende downloads. eine vorgemerkte id im backend würde als
   *  leiche liegenbleiben und den nächsten versuch derselben version killen. */
  cancelRequested?: boolean;
}

interface State {
  releases: GeRelease[];
  loading: boolean;
  loadError: string | null;
  lastFetchedAt: number | null; // letzter echter github-kontakt
  lastSource: FetchSource | null;
  jobs: Record<string, Job>; // key = release.tag
  queue: string[]; // wartende tags (max 1 aktiv)
  activeTag: string | null;
  busyRemove: string | null;
  listenerReady: boolean;
}

export const useProtonStore = defineStore("proton", {
  state: (): State => ({
    releases: [],
    loading: false,
    loadError: null,
    lastFetchedAt: null,
    lastSource: null,
    jobs: {},
    queue: [],
    activeTag: null,
    busyRemove: null,
    listenerReady: false,
  }),
  getters: {
    installedTools(): CompatTool[] {
      return useScanStore().compatTools;
    },
    // GE-tool aus dem user-dir → über protium löschbar (FR-3.4)
    installedTags(): Set<string> {
      return new Set(this.installedTools.map((t) => t.internalName));
    },
    isBusy: (s) => s.activeTag !== null || s.queue.length > 0,
  },
  actions: {
    async init() {
      if (this.listenerReady) return;
      this.listenerReady = true;
      await listen<{ id: string; downloaded: number; total: number | null }>(
        "download-progress",
        (e) => {
          const job = this.jobs[e.payload.id];
          if (job) {
            job.downloaded = e.payload.downloaded;
            job.total = e.payload.total;
          }
        },
      );
      if (!this.releases.length) this.loadReleases();
    },

    async loadReleases(force = false) {
      this.loading = true;
      this.loadError = null;
      try {
        const result = await fetchReleases(tauriPorts.http, tauriPorts.cache, Date.now, force);
        this.releases = result.releases;
        this.lastFetchedAt = result.fetchedAt;
        this.lastSource = result.source;
        if (!this.releases.length && result.source === "offline") {
          this.loadError = t("proton.noReleases");
        }
      } catch (e) {
        this.loadError = errMsg(e);
      } finally {
        this.loading = false;
      }
    },

    queueInstall(release: GeRelease) {
      if (this.jobs[release.tag]) return; // schon in arbeit / queued
      this.jobs[release.tag] = { tag: release.tag, phase: "queued", downloaded: 0, total: null };
      this.queue.push(release.tag);
      void this.pump();
    },

    /** bricht einen download ab — queued: sofort raus; aktiv: rust-abbruch + cleanup. */
    async cancel(tag: string) {
      const queuedIdx = this.queue.indexOf(tag);
      if (queuedIdx >= 0) {
        this.queue.splice(queuedIdx, 1); // noch nicht gestartet → einfach entfernen
        delete this.jobs[tag];
        return;
      }
      if (this.activeTag === tag) {
        // zwei wege, weil sie zwei fenster abdecken:
        // 1. cancelRequested → greift VOR der registrierung im backend
        //    (appCacheDir + hash-asset-abruf); ohne das verpufft der klick still
        //    und der download läuft trotzdem komplett durch.
        // 2. cancelDownload → R-4 pollt die registry, bricht den laufenden
        //    download ab und räumt die partielle datei auf.
        // beide wege enden im wurf von installRelease() → pump()-catch entfernt
        // den job.
        const job = this.jobs[tag];
        if (job) job.cancelRequested = true;
        await tauriPorts.system.cancelDownload(tag).catch(() => {});
      }
    },

    async pump() {
      if (this.activeTag || !this.queue.length) return;
      const tag = this.queue.shift();
      if (!tag) return;
      const release = this.releases.find((r) => r.tag === tag);
      const job = this.jobs[tag];
      if (!release || !job) return;

      this.activeTag = tag;
      const scan = useScanStore();
      const steamRoot = scan.result?.steamRoot;
      try {
        if (!steamRoot) throw new Error(t("proton.noScanResult"));
        const cacheDir = `${await appCacheDir()}/downloads`;
        await installRelease(tauriPorts, {
          steamRoot,
          cacheDir,
          release,
          downloadId: tag,
          onPhase: (p) => {
            job.phase = p;
          },
          isCancelled: () => this.jobs[tag]?.cancelRequested === true,
        });
        await scan.runScan(); // frische compatToolsInstalled + usedBy
        delete this.jobs[tag];
      } catch (e) {
        const msg = errMsg(e);
        if (!/cancel/i.test(msg)) this.loadError = t("proton.installFailed", { tag, msg });
        delete this.jobs[tag];
      } finally {
        this.activeTag = null;
        void this.pump(); // nächster in der queue
      }
    },

    async remove(tool: CompatTool) {
      const scan = useScanStore();
      const steamRoot = scan.result?.steamRoot;
      if (!steamRoot || tool.source !== "user") return;
      this.busyRemove = tool.name;
      try {
        await removeTool(tauriPorts.fs, steamRoot, tool.name);
        await scan.runScan();
      } catch (e) {
        this.loadError = t("proton.removeFailed", { msg: errMsg(e) });
      } finally {
        this.busyRemove = null;
      }
    },
  },
});
