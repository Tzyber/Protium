// ports-implementierung gegen tauri-plugins + rust-commands.
// EINZIGE datei mit tauri-imports auf der core-seite (INV-5).
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appCacheDir, homeDir } from "@tauri-apps/api/path";
import {
  BaseDirectory,
  exists as fsExists,
  readFile as fsReadFile,
  remove as fsRemove,
  mkdir,
  readDir,
  readTextFile,
  rename,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Cache, DirEntry, FileSystem, Http, HttpResponse, Ports, System } from "../ports.js";

const fs: FileSystem = {
  exists: (path) => fsExists(path).catch(() => false),
  readTextFile: (path) => readTextFile(path),
  readFile: (path) => fsReadFile(path),
  async readDir(path) {
    const entries = await readDir(path);
    return entries.map(
      (e): DirEntry => ({
        name: e.name,
        isDirectory: e.isDirectory,
        isSymlink: e.isSymlink,
      }),
    );
  },
  // plugin-fs kann kein realpath → rust canonicalize
  realpath: (path) => invoke<string>("canonicalize_path", { path }),
  remove: (path, opts) => fsRemove(path, { recursive: opts?.recursive ?? false }),
  writeTextFile: (path, content) => writeTextFile(path, content),
  rename: (from, to) => rename(from, to),
  mkdir: (path) => mkdir(path, { recursive: true }),
};

const http: Http = {
  async get(url, opts) {
    const res = await tauriFetch(url, { method: "GET", headers: opts?.headers });
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, ok: res.ok, text, headers } satisfies HttpResponse;
  },
};

const system: System = {
  isProcessRunning: (name) => invoke<boolean>("is_process_running", { name }),
  dirSize: (path) => invoke<number>("dir_size", { path }),
  allowLibraryScope: (path) => invoke<void>("allow_library_scope", { path }),
  pathIdentity: (path) =>
    invoke<{ realpath: string; dev: string; ino: string }>("path_identity", { path }).catch(
      () => null,
    ),
  downloadFile: (url, dest, downloadId) =>
    invoke<string>("download_file", { url, dest, downloadId }),
  cancelDownload: (downloadId) => invoke<void>("cancel_download", { downloadId }),
  extractTarball: (src, dest) => invoke<void>("extract_tarball", { src, dest }),
};

// cache als json-dateien unter dem app-cache-dir
const CACHE_SUBDIR = "cache";
let cacheDirReady: Promise<void> | null = null;
function ensureCacheDir(): Promise<void> {
  cacheDirReady ??= mkdir(CACHE_SUBDIR, { baseDir: BaseDirectory.AppCache, recursive: true }).catch(
    () => {},
  );
  return cacheDirReady;
}
function cacheFile(key: string): string {
  return `${CACHE_SUBDIR}/${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

const cache: Cache = {
  async get(key) {
    try {
      await ensureCacheDir();
      const file = cacheFile(key);
      if (!(await fsExists(file, { baseDir: BaseDirectory.AppCache }))) return null;
      return await readTextFile(file, { baseDir: BaseDirectory.AppCache });
    } catch {
      return null;
    }
  },
  async set(key, value) {
    try {
      await ensureCacheDir();
      await writeTextFile(cacheFile(key), value, { baseDir: BaseDirectory.AppCache });
    } catch {
      // schreibfehler nie fatal (INV-3)
    }
  },
};

export const tauriPorts: Ports = { fs, http, system, cache };

/** $HOME für discoverSteamRoot. */
export function getHome(): Promise<string> {
  return homeDir();
}

/** lokaler pfad → asset-url für die webview. */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

export { appCacheDir };

/** url im system-browser öffnen. */
export function openExternal(url: string): Promise<void> {
  return openUrl(url);
}

/** spiel über steam starten (steam:// handler). steam muss laufen bzw. startet dann. */
export function launchGame(appId: number): Promise<void> {
  return openUrl(`steam://rungameid/${appId}`);
}
