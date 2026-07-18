// einzige schnittstelle von core zur außenwelt: adapter implementieren, tests mocken.

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface FileSystem {
  exists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
  readDir(path: string): Promise<DirEntry[]>;
  /** symlinks aufgelöst. */
  realpath(path: string): Promise<string>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  text: string;
  headers: Record<string, string>;
}

export interface Http {
  get(url: string, opts?: { headers?: Record<string, string> }): Promise<HttpResponse>;
}

export interface PathIdentity {
  realpath: string;
  dev: string; // string: große inodes überschreiten JS-number-präzision
  ino: string;
}

export interface System {
  /** R-2 */ isProcessRunning(name: string): Promise<boolean>;
  /** R-3 */ dirSize(path: string): Promise<number>;
  /** R-5 — muss vor read auf externen pfaden laufen, sonst blockt der fs-scope (FR-1.3). */
  allowLibraryScope(path: string): Promise<void>;
  /** R-6 (dev,ino) zur library-dedup; null wenn nicht erreichbar. */
  pathIdentity(path: string): Promise<PathIdentity | null>;
  /** R-4 streamt nach dest, sha512 im stream → hex-digest; fortschritt via event "download-progress". */
  downloadFile(url: string, dest: string, downloadId: string): Promise<string>;
  /** R-4 abbrechen; räumt die partielle datei auf. */
  cancelDownload(downloadId: string): Promise<void>;
  /** R-1 .tar.gz nach dest entpacken (temp im ziel-fs, EXDEV-safe). */
  extractTarball(src: string, dest: string): Promise<void>;
}

/** persistenter key/value-cache (protondb TTL, github etag). */
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface Ports {
  fs: FileSystem;
  http: Http;
  system: System;
  cache: Cache;
}
