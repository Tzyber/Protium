import { describe, expect, it } from "vitest";
import { discoverSteamRoot } from "../../src/core/paths.js";
import { scanLibrary } from "../../src/core/scan.js";
import {
  buildFakeSteam,
  fakeHttp,
  fakeSystem,
  memCache,
  nodeFs,
} from "../../tests/support/fakeSteam";

describe("scanLibrary (integration — dominiks reales setup)", () => {
  it("dedupliziert libraries, findet system-compat-tools, erfüllt phase-1-akzeptanz", async () => {
    const { home, root, lib2, lib2Dup, staleLib, systemCompat } = await buildFakeSteam();
    const fs = nodeFs();

    const discovered = await discoverSteamRoot(fs, home);
    expect(discovered).toBe(root);

    const system = fakeSystem();
    const result = await scanLibrary(
      { fs, http: fakeHttp(), system, cache: memCache() },
      { home, steamRoot: root, protonDbDelayMs: 0, extraCompatDirs: [systemCompat] },
    );

    // library-dedup: symlink-dup + staler eintrag raus, nur root + lib2 bleiben
    expect(result.libraries).toEqual([root, lib2]);
    expect(system.scopedPaths).toEqual(expect.arrayContaining([root, lib2]));
    expect(result.warnings.some((w) => w.includes(lib2Dup) && w.includes("identischer"))).toBe(
      true,
    );
    expect(
      result.warnings.some((w) => w.includes(staleLib) && w.includes("nicht erreichbar")),
    ).toBe(true);

    const byId = new Map(result.games.map((g) => [g.appId, g]));

    // gefiltert / korrupt nicht enthalten, spiele NICHT dupliziert (dedup wirkt)
    expect(byId.has(1493710)).toBe(false);
    expect(byId.has(9999)).toBe(false);
    expect(result.games.filter((g) => g.appId === 730)).toHaveLength(1);
    expect([...byId.keys()].sort((a, b) => a - b)).toEqual([570, 620, 730]);

    // mappings: 620 → GE, 730 → cachyos-slr (interner name), 570 → default
    expect(byId.get(620)?.compatTool).toBe("GE-Proton9-27");
    expect(byId.get(730)?.compatTool).toBe("proton-cachyos-slr");
    expect(byId.get(570)?.compatTool).toBe("default");
    expect(byId.get(620)?.library).toBe(lib2);
    expect(byId.get(570)?.installed).toBe(true);
    expect(byId.get(570)?.headerImage).toContain("/steam/apps/570/header.jpg");
    expect(byId.get(570)?.protonDb).toEqual({ tier: "unknown", confidence: "unknown" });

    // lokales cover: 620 hat eins im librarycache (hash-unterordner), 570 nicht
    expect(byId.get(620)?.localHeader).toContain("librarycache/620/abc123hash/library_header.jpg");
    expect(byId.get(570)?.localHeader).toBeNull();

    // compat-tools aus BEIDEN quellen (root + system)
    expect(result.compatToolsInstalled).toHaveLength(3);
    const ge = result.compatToolsInstalled.find((t) => t.name === "GE-Proton9-27");
    const cachyLocal = result.compatToolsInstalled.find((t) => t.name === "Proton-CachyOS Latest");
    const cachySystem = result.compatToolsInstalled.find((t) => t.name === "proton-cachyos-slr");

    expect(ge?.usedBy).toEqual([620]);
    // lokales "Proton-CachyOS Latest" (interner name == dir) wird von keinem spiel genutzt
    expect(cachyLocal?.internalName).toBe("Proton-CachyOS Latest");
    expect(cachyLocal?.usedBy).toEqual([]);
    // systemweites proton-cachyos-slr: usedBy NUR installierte echte spiele —
    // appId 0 (default), 999999 (deinstalliert), 2207218128 (shortcut) fallen raus.
    expect(cachySystem?.internalName).toBe("proton-cachyos-slr");
    expect(cachySystem?.displayName).toContain("steam linux runtime");
    expect(cachySystem?.usedBy).toEqual([730]);
    // source: GE + lokales cachy aus user-dir, slr aus system-dir (→ read-only in UI)
    expect(ge?.source).toBe("user");
    expect(cachyLocal?.source).toBe("user");
    expect(cachySystem?.source).toBe("system");

    // globaler default (CompatToolMapping[0]) separat ausgewiesen, nicht in usedBy
    expect(result.defaultCompatTool).toBe("proton-cachyos-slr");

    // korruptes acf → warning, kein crash
    expect(result.warnings.some((w) => w.includes("appmanifest_9999"))).toBe(true);
  });
});
