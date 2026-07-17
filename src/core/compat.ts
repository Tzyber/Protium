import { joinPath, paths, SYSTEM_COMPAT_DIRS } from "./paths.js";
import type { DirEntry, FileSystem, System } from "./ports.js";
import type { CompatTool } from "./types.js";
import { asNode, asString, getPath, parseVdf } from "./vdf.js";

/** appId → compat-tool-name (interner name, wie in config.vdf). */
export type CompatToolMapping = Map<number, string>;

/**
 * liest InstallConfigStore→Software→Valve→Steam→CompatToolMapping.
 * fehlt der teilbaum → leere map (aufrufer setzt "default").
 * ungültiges vdf → wirft; scan fängt ab → mapping "unknown" + warning (FR-1.5).
 */
export function parseCompatToolMapping(configVdfText: string): CompatToolMapping {
  const root = parseVdf(configVdfText);
  const mappingNode = asNode(
    getPath(root, "InstallConfigStore", "Software", "Valve", "Steam", "CompatToolMapping"),
  );
  const out: CompatToolMapping = new Map();
  if (!mappingNode) return out;

  for (const key of Object.keys(mappingNode)) {
    const appId = Number(key);
    if (!Number.isInteger(appId)) continue;
    const name = asString(getPath(mappingNode, key, "name"));
    if (name && name.trim() !== "") out.set(appId, name);
  }
  return out;
}

/** interner tool-name (key in compat_tools) + display_name aus einer vdf. */
function readToolVdf(
  text: string,
  fallbackName: string,
): { internalName: string; displayName: string } {
  let internalName = fallbackName;
  let displayName = fallbackName;
  const compatTools = asNode(getPath(parseVdf(text), "compatibilitytools", "compat_tools"));
  if (compatTools) {
    const internal = Object.keys(compatTools)[0];
    if (internal) {
      internalName = internal;
      const dn = asString(getPath(compatTools, internal, "display_name"));
      if (dn) displayName = dn;
    }
  }
  return { internalName, displayName };
}

/**
 * listet installierte compat-tools aus ALLEN quellen: steam-root
 * (compatibilitytools.d) + systemweite verzeichnisse (/usr/share/steam/…, wo
 * z. B. proton-cachyos vom paketmanager landet).
 *
 * - verzeichnisse werden per identität (dev/ino) dedupliziert, damit der
 *   ~/.steam/steam-symlink nicht dieselben tools doppelt liefert.
 * - externe verzeichnisse werden vor dem read in den fs-scope gehängt (R-5).
 * - usedBy matcht gegen den INTERNEN namen (steht so im mapping), nicht den
 *   verzeichnisnamen. tools werden über den internen namen dedupliziert (erste quelle gewinnt).
 * - defekte einzeltools → skip (INV-2), nie abbruch.
 */
export async function listCompatTools(
  fs: FileSystem,
  system: System,
  steamRoot: string,
  mapping: CompatToolMapping,
  warnings: string[],
  installedAppIds: ReadonlySet<number>,
  extraDirs: readonly string[] = SYSTEM_COMPAT_DIRS,
): Promise<CompatTool[]> {
  // usedBy zählt NUR installierte, echte spiele — nicht stale mapping-einträge
  // (deinstallierte spiele), nicht appId 0 (globaler default) und nicht
  // shortcut-ids von non-steam-games (hohe 32-bit-werte).
  const usedByOf = (id: string): number[] =>
    [...mapping.entries()]
      .filter(([appId, name]) => name === id && installedAppIds.has(appId))
      .map(([appId]) => appId);

  const candidateDirs = [paths.compatToolsDir(steamRoot), ...extraDirs];
  const userDir = paths.compatToolsDir(steamRoot);

  const tools: CompatTool[] = [];
  const seenDirs = new Set<string>(); // dedup via realpath
  const seenInternal = new Set<string>(); // dedup tools über internen namen

  for (const dir of candidateDirs) {
    const source: "user" | "system" = dir === userDir ? "user" : "system";
    // externe/systemweite dirs vor dem read scopen (R-5); root ist bereits im scope.
    if (source === "system") {
      try {
        await system.allowLibraryScope(dir);
      } catch {
        // nicht scope-bar → verzeichnis überspringen
        continue;
      }
    }

    const id = await system.pathIdentity(dir);
    const realKey = id ? id.realpath : dir;
    if (seenDirs.has(realKey)) continue; // symlink-duplikat (z. B. ~/.steam/steam)
    seenDirs.add(realKey);

    let entries: DirEntry[];
    try {
      if (!(await fs.exists(dir))) continue;
      entries = await fs.readDir(dir);
    } catch (e) {
      warnings.push(`compat-verzeichnis "${dir}" nicht lesbar: ${(e as Error).message}`);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const name = entry.name;
      try {
        let internalName = name;
        let displayName = name;
        const vdfPath = paths.compatToolVdfIn(dir, name);
        if (await fs.exists(vdfPath)) {
          ({ internalName, displayName } = readToolVdf(await fs.readTextFile(vdfPath), name));
        }
        if (seenInternal.has(internalName)) continue; // schon aus höher-priorisierter quelle
        seenInternal.add(internalName);

        const sizeBytes = await system.dirSize(joinPath(dir, name));
        const usedBy = usedByOf(internalName);
        if (internalName !== name) {
          for (const appId of usedByOf(name)) if (!usedBy.includes(appId)) usedBy.push(appId);
        }
        tools.push({ name, internalName, displayName, sizeBytes, usedBy, source });
      } catch (e) {
        warnings.push(`compat-tool "${name}" übersprungen: ${(e as Error).message}`);
      }
    }
  }
  return tools;
}
