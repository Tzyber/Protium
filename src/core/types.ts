// domänentypen — UI-frei (INV-5). keine vue-/tauri-imports hier.

export type Tier = "platinum" | "gold" | "silver" | "bronze" | "borked" | "unknown";

export interface Game {
  appId: number;
  name: string;
  library: string;
  sizeBytes: number;
  installed: boolean;
  compatTool: string; // "GE-Proton9-27" | "proton_experimental" | "default" | "unknown"
  protonDb: { tier: Tier; confidence: string } | null;
  localHeader: string | null; // bevorzugt (CDN-unabhängig)
  headerImage: string | null; // CDN-fallback
  launchOptions?: string; // ab phase 4
  prefixPath?: string; // ab phase 5
}

export interface CompatTool {
  name: string; // verzeichnisname in compatibilitytools.d (für fs-ops: größe, löschen)
  internalName: string; // key aus compatibilitytool.vdf → steht so in config.vdf-mapping
  displayName: string;
  sizeBytes: number;
  usedBy: number[]; // appIds, die dieses tool via mapping nutzen
  source: "user" | "system"; // system = distro-dir (/usr/share/…), read-only
}

export interface ScanResult {
  steamRoot: string;
  libraries: string[];
  games: Game[];
  compatToolsInstalled: CompatTool[];
  /** globaler default aus CompatToolMapping[0] ("für alle spiele"), sonst null. */
  defaultCompatTool: string | null;
  /** account, dessen localconfig.vdf gelesen wird (null = keiner gefunden → keine startoptionen). */
  steamUserId: string | null;
  warnings: string[];
}

// StateFlags ist ein bitfield: bit 2 (=4) = fully installed. maskieren, nie === 4,
// weil installiert+update-pending = 6 wäre (S-2).
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
