import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "../../src/core/types";

const { mockFindOrphans, mockReadAllShortcutAppIds } = vi.hoisted(() => ({
  mockFindOrphans: vi.fn(async () => []),
  mockReadAllShortcutAppIds: vi.fn(async () => ({ status: "none" as const })),
}));

vi.mock("../../src/core/cleanup", () => ({
  findOrphans: mockFindOrphans,
}));
vi.mock("../../src/core/shortcuts", () => ({
  readAllShortcutAppIds: mockReadAllShortcutAppIds,
  SHORTCUT_ID_THRESHOLD: 2_147_483_648,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => "deleted"),
}));
vi.mock("../../src/core/adapters/tauri", async () => {
  const tauriPorts = {
    fs: {},
    http: {},
    system: { isProcessRunning: async () => false },
    cache: {},
  };
  return { tauriPorts };
});

import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useScanStore } from "../../src/ui/stores/scanStore";

function fakeScan(skipped?: ScanResult["skippedLibraries"]): ScanResult {
  return {
    steamRoot: "/home/u/.steam",
    libraries: ["/home/u/.steam"],
    games: [],
    compatToolsInstalled: [],
    defaultCompatTool: null,
    steamUserId: null,
    warnings: [],
    skippedLibraries: skipped ?? [],
  };
}

function fakeScanWithGames(gameIds: number[]): ScanResult {
  return {
    ...fakeScan(),
    games: gameIds.map((appId) => ({
      appId,
      name: `Game ${appId}`,
      library: "/home/u/.steam",
      sizeBytes: 100,
      installed: true,
      compatTool: "default",
      protonDb: null,
      localHeader: null,
      headerImage: null,
    })),
  };
}

describe("cleanupStore gate logic", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockFindOrphans.mockReset();
    mockReadAllShortcutAppIds.mockReset();
    mockReadAllShortcutAppIds.mockResolvedValue({ status: "none" });
  });

  it("blockiert wenn scope-failed library vorhanden", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/ext/lib", reason: "scope-failed" }]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("/ext/lib");
    expect(store.orphans).toEqual([]);
  });

  it("blockiert wenn read-failed library vorhanden", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/ext/lib", reason: "read-failed" }]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("/ext/lib");
    expect(store.orphans).toEqual([]);
  });

  it("blockiert wenn scope-failed UND path-missing libraries vorhanden", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([
      { path: "/gone/lib", reason: "path-missing" },
      { path: "/ext/lib", reason: "scope-failed" },
    ]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("/ext/lib");
    expect(store.error).not.toContain("/gone/lib");
    expect(store.pathMissingLibs).toEqual([]);
  });

  it("blockiert NICHT wenn nur path-missing — zeigt stattdessen freigabe-abfrage", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(false);
    expect(store.pathMissingLibs).toEqual(["/gone/lib"]);
    expect(store.pathMissingDismissed).toBe(false);
    expect(store.error).toBeNull();
  });

  it("nach dismissPathMissing lauft scanOrphans durch und cleared pathMissingLibs", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store = useCleanupStore();

    await store.scanOrphans();
    expect(store.pathMissingLibs).toEqual(["/gone/lib"]);

    store.dismissPathMissing();
    await new Promise((r) => setTimeout(r, 0));

    expect(store.pathMissingDismissed).toBe(false);
    expect(store.pathMissingLibs).toEqual([]);
    expect(store.scanning).toBe(false);
  });

  it("deleteOrphans blockiert wenn blockedBySkipped true", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/ext/lib", reason: "read-failed" }]);
    const store = useCleanupStore();

    await store.scanOrphans();
    expect(store.blockedBySkipped).toBe(true);

    await store.deleteOrphans([{ appId: 1, type: "compatdata", path: "/fake", library: "/lib" }]);
    expect(store.deleting.size).toBe(0);
  });

  it("wenn keine skipped libraries → scan lauft normal durch", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(false);
    expect(store.pathMissingLibs).toEqual([]);
    expect(store.error).toBeNull();
  });
});

describe("cleanupStore — S-05 + shortcuts", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockFindOrphans.mockReset();
    mockReadAllShortcutAppIds.mockReset();
    mockReadAllShortcutAppIds.mockResolvedValue({ status: "none" });
  });

  it("S-05: deleteOrphans überspringt einträge deren appId inzwischen installiert ist", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanWithGames([42]); // game 42 is installed
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 42, type: "compatdata", path: "/fake/42", library: "/lib" },
    ]);

    expect(store.error).toContain("inzwischen installiert");
  });

  it("deleteOrphans überspringt shortcut-appId wenn vom parser erkannt", async () => {
    mockReadAllShortcutAppIds.mockResolvedValue({
      status: "ok",
      ids: new Set([3641016077]),
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 3641016077, type: "compatdata", path: "/fake/sc", library: "/lib" },
    ]);

    expect(store.error).toContain("inzwischen installiert");
  });

  it("deleteOrphans blockiert compatdata wenn shortcuts.vdf unreadable", async () => {
    mockReadAllShortcutAppIds.mockResolvedValue({
      status: "unreadable",
      paths: ["/home/u/.steam/userdata/123/config/shortcuts.vdf"],
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
      { appId: 888888, type: "shadercache", path: "/fake/shader", library: "/lib" },
    ]);

    expect(store.error).toContain("nicht lesbar"); // wine-prefix blocked
    expect(store.error).not.toContain("888888"); // shadercache NOT blocked
  });
});
