// implementiert die core-ports gegen die echten tauri-plugins + rust-commands.
// dies ist die EINZIGE datei mit tauri-imports auf der core-seite (INV-5 bleibt
// gewahrt: core/*.ts kennt nur ports.ts, nicht diese datei).
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appCacheDir, homeDir } from "@tauri-apps/api/path";
import {
  BaseDirectory,
  exists as fsExists,
  remove as fsRemove,
  mkdir,
  readDir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Cache, DirEntry, FileSystem, Http, HttpResponse, Ports, System } from "../ports.js";

const fs: FileSystem = {
  exists: (path) => fsExists(path),
  readTextFile: (path) => readTextFile(path),
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
  // plugin-fs kennt kein realpath → rust std::fs::canonicalize (symlink-auflösung).
  realpath: (path) => invoke<string>("canonicalize_path", { path }),
  remove: (path, opts) => fsRemove(path, { recursive: opts?.recursive ?? false }),
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

// cache als json-dateien unter dem app-cache-dir (~/.cache/com.protium.desktop/).
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
      // cache-schreibfehler nie fatal (INV-3)
    }
  },
};

export const tauriPorts: Ports = { fs, http, system, cache };

/** $HOME für discoverSteamRoot (tauri-path-api). */
export function getHome(): Promise<string> {
  return homeDir();
}

/** wandelt einen lokalen fs-pfad in eine von der webview ladbare asset-url. */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

export { appCacheDir };

/** url im system-standardbrowser öffnen (tauri-opener-plugin). */
export function openExternal(url: string): Promise<void> {
  return openUrl(url);
}
