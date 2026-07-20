// INV-1 write-gate für steam-dateien: steam-läuft-check → backup → atomares temp+rename.
import { joinPath } from "./paths.js";
import type { FileSystem, System } from "./ports.js";

export class SteamRunningError extends Error {
  constructor() {
    super(
      "steam läuft gerade — die änderung würde beim beenden überschrieben. bitte steam erst beenden.",
    );
    this.name = "SteamRunningError";
  }
}

/**
 * schreibt `content` nach `path` mit write-gate (INV-1).
 * der steam-check ist doppelt wichtig: steam schreibt vdf-dateien beim beenden zurück
 * → ein write bei laufendem steam würde still revertiert.
 * backup nur wenn die zieldatei existiert; temp+rename im selben verzeichnis
 * (gleiches dateisystem → atomar, kein EXDEV-problem).
 */
export async function writeSteamFile(
  fs: FileSystem,
  system: System,
  path: string,
  content: string,
  backupDir: string,
): Promise<void> {
  // "steam" matcht per substring auch steamwebhelper — im zweifel lieber blockieren (sichere richtung)
  if (await system.isProcessRunning("steam")) throw new SteamRunningError();

  if (await fs.exists(path)) {
    await fs.mkdir(backupDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.split("/").pop() ?? "steam-datei";
    await fs.writeTextFile(joinPath(backupDir, `${base}.${stamp}`), await fs.readTextFile(path));
  }

  const tmp = `${path}.protium-tmp`;
  try {
    await fs.writeTextFile(tmp, content);
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.remove(tmp).catch(() => {});
    throw e;
  }
}
