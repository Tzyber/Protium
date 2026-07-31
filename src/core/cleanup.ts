import { paths } from "./paths.js";
import type { DirEntry, FileSystem } from "./ports.js";
import type { OrphanEntry, OrphanType } from "./types.js";

const ORPHAN_TYPES: OrphanType[] = ["compatdata", "shadercache"];

export const NUMERIC_RE = /^\d+$/;

export async function findOrphans(
  libraries: readonly string[],
  installedAppIds: ReadonlySet<number>,
  fs: FileSystem,
): Promise<OrphanEntry[]> {
  const orphans: OrphanEntry[] = [];

  for (const lib of libraries) {
    for (const type of ORPHAN_TYPES) {
      const dir = type === "compatdata" ? paths.compatdataDir(lib) : paths.shadercacheDir(lib);

      let entries: DirEntry[];
      try {
        entries = await fs.readDir(dir);
      } catch {
        continue; // INV-2: verzeichnis existiert nicht / nicht lesbar → skip
      }

      for (const entry of entries) {
        if (!entry.isDirectory || entry.isSymlink) continue;
        if (!NUMERIC_RE.test(entry.name)) continue;
        const appId = parseInt(entry.name, 10);
        // M4.1 (audit-befund): riesige ziffernfolgen parsen jenseits der
        // JS-präzision (NAME_MAX erlaubt 254 ziffern → 1.8e254). solche
        // appIds sind nie legitim (steam: ≤ 10 stellen) und würden das
        // rust-backend (u64-parse) beim löschen ratlos lassen.
        if (appId === 0 || !Number.isFinite(appId) || appId > Number.MAX_SAFE_INTEGER) continue;
        if (installedAppIds.has(appId)) continue;

        const orphanPath =
          type === "compatdata"
            ? paths.compatdataPath(lib, entry.name)
            : paths.shadercachePath(lib, entry.name);

        orphans.push({
          appId,
          type,
          path: orphanPath,
          library: lib,
        });
      }
    }
  }

  return orphans;
}
