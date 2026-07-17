import { isBlocked } from "./blocklist.js";
import { type CompatToolMapping, listCompatTools, parseCompatToolMapping } from "./compat.js";
import { parseLibraryFolders } from "./libraryfolders.js";
import { parseManifest } from "./manifest.js";
import { joinPath, LOCAL_HEADER_FILENAME, paths } from "./paths.js";
import type { DirEntry, Ports } from "./ports.js";
import { ProtonDbClient } from "./protondb.js";
import type { Game, ScanResult } from "./types.js";

export interface ScanOptions {
  /** $HOME des users (adapter liefert via tauri-path-api). */
  home: string;
  steamRoot: string;
  /** höflichkeits-delay zwischen protondb-netzwerkabfragen (default 150ms). */
  protonDbDelayMs?: number;
  /** override der systemweiten compat-dirs (v. a. für tests). default: SYSTEM_COMPAT_DIRS. */
  extraCompatDirs?: readonly string[];
}

const MANIFEST_RE = /^appmanifest_(\d+)\.acf$/;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * sucht das lokale cover (library_header.jpg) im steam-bildcache. neuere steam-
 * versionen legen es unter appcache/librarycache/{appId}/{hash}/library_header.jpg
 * ab (hash-unterordner). gibt den absoluten pfad zurück oder null (INV-2/3).
 */
async function resolveLocalHeader(
  fs: Ports["fs"],
  steamRoot: string,
  appId: number,
): Promise<string | null> {
  const dir = paths.libraryCacheAppDir(steamRoot, appId);
  try {
    if (!(await fs.exists(dir))) return null;
    for (const entry of await fs.readDir(dir)) {
      if (!entry.isDirectory) continue;
      const candidate = joinPath(dir, entry.name, LOCAL_HEADER_FILENAME);
      if (await fs.exists(candidate)) return candidate;
    }
  } catch {
    // cache defekt/unlesbar → einfach kein lokales bild
  }
  return null;
}

/**
 * kompletter read-only-scan. degradiert bei defekten dateien zu skip+warning
 * (INV-2) und bei netzwerkausfall zu tier "unknown" (INV-3). wirft nur, wenn
 * gar keine steam-root existiert (davor: discoverSteamRoot).
 */
export async function scanLibrary(ports: Ports, opts: ScanOptions): Promise<ScanResult> {
  const { fs, system } = ports;
  const { steamRoot } = opts;
  const warnings: string[] = [];

  // 1) libraries bestimmen. defekt/fehlt → nur die root als einzige library.
  let libraries: string[] = [];
  try {
    const lfPath = paths.libraryFoldersVdf(steamRoot);
    if (await fs.exists(lfPath)) {
      libraries = parseLibraryFolders(await fs.readTextFile(lfPath));
    }
  } catch (e) {
    warnings.push(`libraryfolders.vdf nicht lesbar: ${(e as Error).message}`);
  }
  if (libraries.length === 0) libraries = [steamRoot];

  // 1b) libraries kanonisch deduplizieren (INV: keine doppelten spiele/größen).
  //   - pathIdentity null → pfad nicht erreichbar (staler libraryfolders-eintrag) → warning+skip.
  //   - gleiche (dev,ino) → symlink ODER doppelt gemounteter datenträger (gleiche UUID)
  //     wie /run/media/... vs /mnt/... → duplikat, warnung, überspringen.
  const uniqueLibraries: string[] = [];
  const seenIdentity = new Map<string, string>();
  for (const lib of libraries) {
    const id = await system.pathIdentity(lib);
    if (!id) {
      warnings.push(`library-pfad nicht erreichbar, übersprungen (evtl. nicht gemountet): ${lib}`);
      continue;
    }
    const key = `${id.dev}:${id.ino}`;
    const first = seenIdentity.get(key);
    if (first) {
      warnings.push(
        `library "${lib}" ist dieselbe wie "${first}" (identischer datenträger), übersprungen`,
      );
      continue;
    }
    seenIdentity.set(key, lib);
    uniqueLibraries.push(lib);
  }
  libraries = uniqueLibraries;

  // 2) compat-mapping (liegt in der root). fehlt/korrupt → per-spiel "unknown".
  let mapping: CompatToolMapping = new Map();
  let mappingUsable = true;
  try {
    const cfgPath = paths.configVdf(steamRoot);
    if (await fs.exists(cfgPath)) {
      mapping = parseCompatToolMapping(await fs.readTextFile(cfgPath));
    } else {
      mappingUsable = false;
      warnings.push("config.vdf fehlt → compat-tools als 'unknown' markiert");
    }
  } catch (e) {
    mappingUsable = false;
    warnings.push(`config.vdf nicht lesbar: ${(e as Error).message}`);
  }
  const compatFor = (appId: number): string =>
    !mappingUsable ? "unknown" : (mapping.get(appId) ?? "default");

  // 3) manifests je library. externe mounts vor dem read scopen (FR-1.3, R-5).
  const games: Game[] = [];
  for (const lib of libraries) {
    try {
      await system.allowLibraryScope(lib);
    } catch (e) {
      warnings.push(`library "${lib}" nicht scope-bar, übersprungen: ${(e as Error).message}`);
      continue;
    }
    const appsDir = paths.libraryAppsDir(lib);
    let entries: DirEntry[];
    try {
      if (!(await fs.exists(appsDir))) continue;
      entries = await fs.readDir(appsDir);
    } catch (e) {
      warnings.push(`library "${lib}" nicht lesbar: ${(e as Error).message}`);
      continue;
    }
    for (const entry of entries) {
      const m = MANIFEST_RE.exec(entry.name);
      if (!m) continue;
      try {
        const data = parseManifest(await fs.readTextFile(`${appsDir}/${entry.name}`));
        if (isBlocked(data.appId, data.name)) continue;
        games.push({
          appId: data.appId,
          name: data.name,
          library: lib,
          sizeBytes: data.sizeBytes,
          installed: data.installed,
          compatTool: compatFor(data.appId),
          protonDb: null,
          localHeader: await resolveLocalHeader(fs, steamRoot, data.appId),
          headerImage: paths.headerImageUrl(data.appId),
        });
      } catch (e) {
        warnings.push(`${entry.name} übersprungen: ${(e as Error).message}`);
      }
    }
  }

  // 4) installierte compat-tools
  // 4) installierte compat-tools — usedBy nur gegen tatsächlich gescannte spiele
  const installedAppIds = new Set(games.map((g) => g.appId));
  const defaultCompatTool = mapping.get(0) ?? null; // CompatToolMapping[0] = globaler default
  const compatToolsInstalled = await listCompatTools(
    fs,
    system,
    steamRoot,
    mapping,
    warnings,
    installedAppIds,
    opts.extraCompatDirs,
  );

  // 5) protondb sequenziell, degradiert still zu unknown
  const client = new ProtonDbClient(ports.http, ports.cache);
  const delay = opts.protonDbDelayMs ?? 150;
  for (const game of games) {
    game.protonDb = (await client.getSummary(game.appId)) ?? {
      tier: "unknown",
      confidence: "unknown",
    };
    if (delay > 0) await sleep(delay);
  }

  return { steamRoot, libraries, games, compatToolsInstalled, defaultCompatTool, warnings };
}
