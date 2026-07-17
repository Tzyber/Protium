// ports = die einzige art, wie core mit der außenwelt spricht.
// adapter (tauri) implementieren diese; tests mocken sie.

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface FileSystem {
  exists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
  readDir(path: string): Promise<DirEntry[]>;
  /** kanonischer pfad, symlinks aufgelöst (~/.steam/steam → …/.local/share/Steam). */
  realpath(path: string): Promise<string>;
  /** datei oder verzeichnis löschen (verzeichnis rekursiv). */
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
  dev: string; // als string, um JS-number-präzisionsverlust bei großen inodes zu vermeiden
  ino: string;
}

export interface System {
  /** R-2 */ isProcessRunning(name: string): Promise<boolean>;
  /** R-3 rekursive verzeichnisgröße in bytes. */ dirSize(path: string): Promise<number>;
  /**
   * R-5 zur laufzeit entdeckte library (evtl. auf anderem mount) in den
   * tauri-fs-scope aufnehmen. MUSS vor jedem read auf externen pfaden laufen
   * (FR-1.3), sonst blockt der statische scope den zugriff.
   */
  allowLibraryScope(path: string): Promise<void>;
  /**
   * R-6 kanonischer pfad + (dev, ino) zur dedup identischer libraries
   * (symlink ODER doppelt gemounteter datenträger, gleiche UUID). null, wenn
   * der pfad nicht existiert/erreichbar ist (staler libraryfolders-eintrag).
   */
  pathIdentity(path: string): Promise<PathIdentity | null>;
  /**
   * R-4 großen download streamend nach `dest`, sha512 im selben stream berechnet
   * → rückgabe hex-digest. fortschritt via event "download-progress" (UI abonniert).
   */
  downloadFile(url: string, dest: string, downloadId: string): Promise<string>;
  /** R-1 .tar.gz nach `dest` entpacken (temp im ziel-fs, atomisches rename, EXDEV). */
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
