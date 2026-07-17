import { listen } from "@tauri-apps/api/event";
import { defineStore } from "pinia";
import { appCacheDir, tauriPorts } from "../../core/adapters/tauri";
import { fetchReleases, type GeRelease, installRelease, removeTool } from "../../core/geproton";
import type { CompatTool } from "../../core/types";
import { useScanStore } from "./scanStore";

type Phase = "queued" | "downloading" | "verifying" | "extracting";

interface Job {
  tag: string;
  phase: Phase;
  downloaded: number;
  total: number | null;
}

interface State {
  releases: GeRelease[];
  loading: boolean;
  loadError: string | null;
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

    async loadReleases() {
      this.loading = true;
      this.loadError = null;
      try {
        this.releases = await fetchReleases(tauriPorts.http, tauriPorts.cache);
        if (!this.releases.length) this.loadError = "keine releases (offline oder rate-limit?)";
      } catch (e) {
        this.loadError = (e as Error).message;
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
        if (!steamRoot) throw new Error("kein scan-ergebnis — erst library scannen");
        const cacheDir = `${await appCacheDir()}/downloads`;
        job.phase = "downloading";
        // verify/extract-phasen setzen wir um die core-schritte herum
        await installRelease(tauriPorts, { steamRoot, cacheDir, release, downloadId: tag });
        job.phase = "extracting";
        await scan.runScan(); // frische compatToolsInstalled + usedBy
        delete this.jobs[tag];
      } catch (e) {
        job.phase = "queued";
        this.loadError = `install ${tag} fehlgeschlagen: ${(e as Error).message}`;
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
        this.loadError = `löschen fehlgeschlagen: ${(e as Error).message}`;
      } finally {
        this.busyRemove = null;
      }
    },
  },
});
