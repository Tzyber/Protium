import { isBlocked } from "./blocklist.js";
import { type CompatToolMapping, listCompatTools, parseCompatToolMapping } from "./compat.js";
import { parseLibraryFolders } from "./libraryfolders.js";
import { parseManifest } from "./manifest.js";
import { joinPath, LOCAL_HEADER_FILENAME, paths } from "./paths.js";
import type { DirEntry, Ports } from "./ports.js";
import { ProtonDbClient } from "./protondb.js";
import type { Game, ScanResult } from "./types.js";

export interface ScanOptions {
  home: string;
  steamRoot: string;
  protonDbDelayMs?: number;
  /** compat-dirs überschreiben — für tests. */
  extraCompatDirs?: readonly string[];
}

const MANIFEST_RE = /^appmanifest_(\d+)\.acf$/;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// cover liegt unter librarycache/{appId}/{hash}/ — hash-unterordner muss durchsucht werden.
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
    // defekt → kein cover (INV-2)
  }
  return null;
}

// defekte dateien → skip+warning (INV-2), netzausfall → tier "unknown" (INV-3).
export async function scanLibrary(ports: Ports, opts: ScanOptions): Promise<ScanResult> {
  const { fs, system } = ports;
  const { steamRoot } = opts;
  const warnings: string[] = [];

  let libraries: string[] = [];
  try {
    const lfPath = paths.libraryFoldersVdf(steamRoot);
    if (await fs.exists(lfPath)) {
      libraries = parseLibraryFolders(await fs.readTextFile(lfPath));
    }
  } catch (e) {
    warnings.push(`libraryfolders.vdf nicht lesbar: ${(e as Error).message}`);
  }
  if (libraries.length === 0) libraries = [steamRoot]; // fallback: root ist selbst eine library

  // (dev,ino) fängt denselben datenträger über zwei mountpoints (z. B. /run/media vs /mnt).
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

  const games: Game[] = [];
  for (const lib of libraries) {
    try {
      await system.allowLibraryScope(lib); // externe mounts vor read freigeben (R-5)
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

  const installedAppIds = new Set(games.map((g) => g.appId));
  const defaultCompatTool = mapping.get(0) ?? null; // mapping[0] = globaler default
  const compatToolsInstalled = await listCompatTools(
    fs,
    system,
    steamRoot,
    mapping,
    warnings,
    installedAppIds,
    opts.extraCompatDirs,
  );

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
