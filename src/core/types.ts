// domänentypen — UI-frei (INV-5). keine vue-/tauri-imports hier.

export type Tier = "platinum" | "gold" | "silver" | "bronze" | "borked" | "unknown";

export interface Game {
  appId: number;
  name: string;
  library: string; // absoluter pfad der library, in der das spiel liegt
  sizeBytes: number;
  installed: boolean;
  compatTool: string; // "GE-Proton9-27" | "proton_experimental" | "default" | "unknown"
  protonDb: { tier: Tier; confidence: string } | null;
  localHeader: string | null; // lokaler pfad aus appcache/librarycache (bevorzugt, CDN-unabhängig)
  headerImage: string | null; // steam cdn-fallback
  launchOptions?: string; // ab phase 4
  prefixPath?: string; // ab phase 5
}

export interface CompatTool {
  name: string; // verzeichnisname in compatibilitytools.d (für fs-ops: größe, löschen)
  internalName: string; // key aus compatibilitytool.vdf → steht so in config.vdf-mapping
  displayName: string;
  sizeBytes: number;
  usedBy: number[]; // appIds, die dieses tool via mapping nutzen
  source: "user" | "system"; // user = steam-root/compatibilitytools.d, system = /usr/share/… (distro, read-only)
}

export interface ScanResult {
  steamRoot: string;
  libraries: string[];
  games: Game[];
  compatToolsInstalled: CompatTool[];
  /** globaler default aus CompatToolMapping[0] ("für alle spiele"), sonst null. */
  defaultCompatTool: string | null;
  warnings: string[];
}

// steam meldet StateFlags als bitfield. bit 2 (wert 4) = fully installed.
// installiert + update-pending = 4|2 = 6 → deshalb maskieren, nie === 4 (S-2).
export const STATE_FLAG_FULLY_INSTALLED = 4;

export function isFullyInstalled(stateFlags: number): boolean {
  return (stateFlags & STATE_FLAG_FULLY_INSTALLED) !== 0;
}

export class SteamNotFoundError extends Error {
  constructor(triedPaths: string[]) {
    super(`keine steam-installation gefunden. geprüfte pfade: ${triedPaths.join(", ")}`);
    this.name = "SteamNotFoundError";
  }
}
