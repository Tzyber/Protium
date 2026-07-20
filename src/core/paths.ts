// INV-4: NUR diese datei konstruiert steam-pfade.
import type { FileSystem } from "./ports.js";
import { SteamNotFoundError } from "./types.js";

const ROOT_CANDIDATES = [
  ".local/share/Steam",
  ".steam/steam", // symlink → meist .local/share/Steam
  ".steam/root",
  ".var/app/com.valvesoftware.Steam/.local/share/Steam", // flatpak
] as const;

function join(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter(Boolean)
    .join("/");
}

// symlinks aufgelöst, damit scope-checks gegen den echten pfad matchen (S-4).
export async function discoverSteamRoot(fs: FileSystem, home: string): Promise<string> {
  const tried: string[] = [];
  for (const rel of ROOT_CANDIDATES) {
    const candidate = join(home, rel);
    tried.push(candidate);
    if (await fs.exists(candidate)) {
      const real = await fs.realpath(candidate);
      // echte root hat steamapps/
      if (await fs.exists(join(real, "steamapps"))) return real;
    }
  }
  throw new SteamNotFoundError(tried);
}

export const paths = {
  steamapps: (root: string) => join(root, "steamapps"),
  libraryFoldersVdf: (root: string) => join(root, "steamapps", "libraryfolders.vdf"),
  configVdf: (root: string) => join(root, "config", "config.vdf"), // mapping liegt in der root
  loginusersVdf: (root: string) => join(root, "config", "loginusers.vdf"),
  compatToolsDir: (root: string) => join(root, "compatibilitytools.d"),
  compatToolVdf: (root: string, toolDir: string) =>
    join(root, "compatibilitytools.d", toolDir, "compatibilitytool.vdf"),
  compatToolVdfIn: (baseDir: string, toolDir: string) =>
    join(baseDir, toolDir, "compatibilitytool.vdf"),
  userdataDir: (root: string) => join(root, "userdata"),
  localConfigVdf: (root: string, userId: string) =>
    join(root, "userdata", userId, "config", "localconfig.vdf"),
  libraryAppsDir: (libraryPath: string) => join(libraryPath, "steamapps"),
  appManifest: (libraryPath: string, appId: number) =>
    join(libraryPath, "steamapps", `appmanifest_${appId}.acf`),
  compatdata: (libraryPath: string, appId: number) =>
    join(libraryPath, "steamapps", "compatdata", String(appId)),
  shadercache: (libraryPath: string, appId: number) =>
    join(libraryPath, "steamapps", "shadercache", String(appId)),
  headerImageUrl: (appId: number) =>
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
  // hash-unterordner, zentral in der root (nicht pro library)
  libraryCacheAppDir: (root: string, appId: number) =>
    join(root, "appcache", "librarycache", String(appId)),
};

export const LOCAL_HEADER_FILENAME = "library_header.jpg";

export { join as joinPath };

// distro-/paket-tools (z. B. proton-cachyos); steam durchsucht diese zusätzlich.
export const SYSTEM_COMPAT_DIRS = [
  "/usr/share/steam/compatibilitytools.d",
  "/usr/local/share/steam/compatibilitytools.d",
] as const;
