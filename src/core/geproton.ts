import { joinPath, paths } from "./paths.js";
import type { Cache, FileSystem, Http, System } from "./ports.js";

const RELEASES_URL =
"https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases?per_page=15";
const CACHE_KEY = "gh:ge-releases";
const TTL_MS = 60 * 60 * 1000; // 1h (FR-3.1)
const MAX_NOTES = 280;

export interface GeAsset {
  name: string;
  url: string;
  size: number;
}

export interface GeRelease {
  tag: string; // = verzeichnisname nach install (z. B. "GE-Proton9-27")
  name: string;
  publishedAt: string;
  notes: string;
  tarball: GeAsset;
  sha512Url: string | null;
}

interface CacheEntry {
  etag: string | null;
  fetchedAt: number;
  releases: GeRelease[];
}

/** woher die zuletzt gelieferten daten stammen — fürs UI-feedback. */
export type FetchSource = "cache" | "not-modified" | "fresh" | "offline";

export interface FetchResult {
  releases: GeRelease[];
  fetchedAt: number; // zeitpunkt des letzten echten github-kontakts
  source: FetchSource;
}

interface RawAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}
interface RawRelease {
  tag_name?: unknown;
  name?: unknown;
  published_at?: unknown;
  body?: unknown;
  assets?: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseReleases(json: string): GeRelease[] {
  const raw = JSON.parse(json);
  if (!Array.isArray(raw)) return [];
  const out: GeRelease[] = [];
  for (const r of raw as RawRelease[]) {
    const assets = Array.isArray(r.assets) ? (r.assets as RawAsset[]) : [];
    let tarball: GeAsset | null = null;
    let sha512Url: string | null = null;
    for (const a of assets) {
      const name = str(a.name);
      const url = str(a.browser_download_url);
      if (!name || !url) continue;
      if (name.endsWith(".tar.gz")) {
        tarball = { name, url, size: typeof a.size === "number" ? a.size : 0 };
      } else if (name.endsWith(".sha512sum")) {
        sha512Url = url;
      }
    }
    if (!tarball) continue; // release ohne tarball ist für uns wertlos
    const tag = tarball.name.replace(/\.tar\.gz$/, "");
    const body = str(r.body);
    out.push({
      tag,
      name: str(r.name) || tag,
             publishedAt: str(r.published_at),
             notes: body.length > MAX_NOTES ? `${body.slice(0, MAX_NOTES).trimEnd()}…` : body,
             tarball,
             sha512Url,
    });
  }
  return out;
}

/**
 * lädt die GE-releases mit 1h-cache + etag-conditional-request.
 * 403/rate-limit/offline → letzter cache-stand oder [] (INV-3), nie throw.
 */
export async function fetchReleases(
  http: Http,
  cache: Cache,
  now: () => number = Date.now,
): Promise<FetchResult> {
  let cached: CacheEntry | null = null;
  try {
    const raw = await cache.get(CACHE_KEY);
    if (raw) cached = JSON.parse(raw) as CacheEntry;
  } catch {
    cached = null;
  }

  if (cached && now() - cached.fetchedAt < TTL_MS) {
    return { releases: cached.releases, fetchedAt: cached.fetchedAt, source: "cache" };
  }

  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "protium",
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;

    const res = await http.get(RELEASES_URL, { headers });

    if (res.status === 304 && cached) {
      const at = now();
      await cache.set(CACHE_KEY, JSON.stringify({ ...cached, fetchedAt: at } satisfies CacheEntry));
      return { releases: cached.releases, fetchedAt: at, source: "not-modified" };
    }
    if (!res.ok) {
      // 403 rate-limit etc. → letzter stand
      return {
        releases: cached?.releases ?? [],
        fetchedAt: cached?.fetchedAt ?? now(),
        source: "offline",
      };
    }

    const at = now();
    const releases = parseReleases(res.text);
    await cache.set(
      CACHE_KEY,
      JSON.stringify({
        etag: res.headers.etag ?? null,
        fetchedAt: at,
        releases,
      } satisfies CacheEntry),
    );
    return { releases, fetchedAt: at, source: "fresh" };
  } catch {
    return {
      releases: cached?.releases ?? [],
      fetchedAt: cached?.fetchedAt ?? now(),
      source: "offline",
    };
  }
}

/** erster whitespace-getrennte token einer .sha512sum-datei = der hash. */
function parseSha512Sum(text: string): string | null {
  const token = text.trim().split(/\s+/)[0];
  return token && /^[0-9a-fA-F]{128}$/.test(token) ? token.toLowerCase() : null;
}

export interface InstallOpts {
  steamRoot: string;
  cacheDir: string; // wohin der tarball zwischengeladen wird (app-cache)
  release: GeRelease;
  downloadId: string; // korreliert progress-events
}

/**
 * lädt, prüft (sha512) und installiert ein GE-release nach compatibilitytools.d.
 * abbruch/fehler hinterlässt nichts halbes: temp-tarball wird immer aufgeräumt,
 * R-1 entpackt atomar (temp im ziel-fs + rename). wirft bei checksum-mismatch.
 */
export async function installRelease(
  ports: { fs: FileSystem; http: Http; system: System },
  opts: InstallOpts,
): Promise<void> {
  const { fs, http, system } = ports;
  const dest = joinPath(opts.cacheDir, opts.release.tarball.name);

  // erwarteten hash holen (falls asset vorhanden) — fehlt er, wird ohne prüfung installiert
  let expected: string | null = null;
  if (opts.release.sha512Url) {
    try {
      const res = await http.get(opts.release.sha512Url);
      if (res.ok) expected = parseSha512Sum(res.text);
    } catch {
      expected = null;
    }
  }

  try {
    const actual = await system.downloadFile(opts.release.tarball.url, dest, opts.downloadId);
    if (expected && actual.toLowerCase() !== expected) {
      throw new Error(
        `checksum stimmt nicht (erwartet ${expected.slice(0, 12)}…, war ${actual.slice(0, 12)}…)`,
      );
    }
    await system.extractTarball(dest, paths.compatToolsDir(opts.steamRoot));
  } finally {
    await fs.remove(dest).catch(() => {}); // tarball immer wegräumen
  }
}

/** entfernt ein installiertes tool-verzeichnis. NUR für GE-tools aufrufen (nicht distro). */
export async function removeTool(
  fs: FileSystem,
  steamRoot: string,
  toolDirName: string,
): Promise<void> {
  await fs.remove(joinPath(paths.compatToolsDir(steamRoot), toolDirName), { recursive: true });
}
