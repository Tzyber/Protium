import { describe, expect, it, vi } from "vitest";
import { fetchReleases, type GeRelease, installRelease } from "../../src/core/geproton.js";
import type { FileSystem, Http, HttpResponse, System } from "../../src/core/ports.js";
import { memCache } from "../support/fakeSteam.js";

function ghBody() {
  return JSON.stringify([
    {
      tag_name: "GE-Proton9-27",
      name: "GE-Proton9-27",
      published_at: "2025-01-01T00:00:00Z",
      body: "x".repeat(400),
      assets: [
        { name: "GE-Proton9-27.tar.gz", browser_download_url: "https://dl/ge.tar.gz", size: 400 },
        { name: "GE-Proton9-27.sha512sum", browser_download_url: "https://dl/ge.sha512sum" },
      ],
    },
    { tag_name: "no-tarball", assets: [] }, // muss rausgefiltert werden
  ]);
}

function httpOnce(response: Partial<HttpResponse>, spy?: () => void): Http {
  return {
    async get() {
      spy?.();
      return { status: 200, ok: true, text: "", headers: {}, ...response };
    },
  };
}

describe("fetchReleases", () => {
  it("parst releases, filtert tarball-lose, kürzt notes", async () => {
    const rels = await fetchReleases(
      httpOnce({ text: ghBody(), headers: { etag: '"abc"' } }),
      memCache(),
    );
    expect(rels).toHaveLength(1);
    expect(rels[0]?.tag).toBe("GE-Proton9-27");
    expect(rels[0]?.tarball.url).toBe("https://dl/ge.tar.gz");
    expect(rels[0]?.sha512Url).toBe("https://dl/ge.sha512sum");
    expect(rels[0]?.notes.endsWith("…")).toBe(true);
  });

  it("cache-hit innerhalb TTL vermeidet http", async () => {
    let calls = 0;
    const cache = memCache();
    const http = httpOnce({ text: ghBody(), headers: { etag: '"abc"' } }, () => calls++);
    await fetchReleases(http, cache);
    await fetchReleases(http, cache);
    expect(calls).toBe(1);
  });

  it("304 → nutzt cache weiter, aktualisiert fetchedAt", async () => {
    const cache = memCache();
    let t = 0;
    let calls = 0;
    const r200: HttpResponse = {
      status: 200,
      ok: true,
      text: ghBody(),
      headers: { etag: '"v1"' },
    };
    const r304: HttpResponse = { status: 304, ok: false, text: "", headers: {} };
    const http: Http = {
      async get(_u, opts) {
        calls++;
        if (calls === 1) return r200;
        expect(opts?.headers?.["If-None-Match"]).toBe('"v1"'); // conditional request
        return r304;
      },
    };
    const rels1 = await fetchReleases(http, cache, () => t);
    t = TTL_OVER;
    const rels2 = await fetchReleases(http, cache, () => t);
    expect(rels2).toEqual(rels1);
    expect(calls).toBe(2);
  });

  it("403 rate-limit → letzter cache-stand (INV-3)", async () => {
    const cache = memCache();
    let t = 0;
    let first = true;
    const ok: HttpResponse = { status: 200, ok: true, text: ghBody(), headers: {} };
    const limited: HttpResponse = { status: 403, ok: false, text: "rate limit", headers: {} };
    const http: Http = {
      async get() {
        if (first) {
          first = false;
          return ok;
        }
        return limited;
      },
    };
    await fetchReleases(http, cache, () => t);
    t = TTL_OVER;
    const rels = await fetchReleases(http, cache, () => t);
    expect(rels).toHaveLength(1); // cache statt leer
  });

  it("offline ohne cache → [] statt throw", async () => {
    const http: Http = {
      get() {
        return Promise.reject(new Error("offline"));
      },
    };
    expect(await fetchReleases(http, memCache())).toEqual([]);
  });
});

const TTL_OVER = 60 * 60 * 1000 + 1;

const release: GeRelease = {
  tag: "GE-Proton9-27",
  name: "GE-Proton9-27",
  publishedAt: "",
  notes: "",
  tarball: { name: "GE-Proton9-27.tar.gz", url: "https://dl/ge.tar.gz", size: 400 },
  sha512Url: "https://dl/ge.sha512sum",
};

function installMocks(downloadHash: string, sha512Body: string) {
  const removed: string[] = [];
  const extracted: [string, string][] = [];
  const fs = {
    remove: vi.fn(async (p: string) => {
      removed.push(p);
    }),
  } as unknown as FileSystem;
  const http: Http = {
    async get() {
      return { status: 200, ok: true, text: sha512Body, headers: {} };
    },
  };
  const system = {
    downloadFile: vi.fn(async () => downloadHash),
    extractTarball: vi.fn(async (s: string, d: string) => {
      extracted.push([s, d]);
    }),
  } as unknown as System;
  return { fs, http, system, removed, extracted };
}

describe("installRelease", () => {
  const goodHash = "a".repeat(128);

  it("checksum ok → entpackt + räumt tarball auf", async () => {
    const m = installMocks(goodHash, `${goodHash}  GE-Proton9-27.tar.gz`);
    await installRelease(m, { steamRoot: "/root", cacheDir: "/cache", release, downloadId: "1" });
    expect(m.extracted).toHaveLength(1);
    expect(m.extracted[0]?.[1]).toBe("/root/compatibilitytools.d");
    expect(m.removed).toContain("/cache/GE-Proton9-27.tar.gz"); // cleanup
  });

  it("checksum-mismatch → wirft + räumt trotzdem auf, kein extract", async () => {
    const m = installMocks(goodHash, `${"b".repeat(128)}  GE-Proton9-27.tar.gz`);
    await expect(
      installRelease(m, { steamRoot: "/root", cacheDir: "/cache", release, downloadId: "1" }),
    ).rejects.toThrow(/checksum/);
    expect(m.extracted).toHaveLength(0);
    expect(m.removed).toContain("/cache/GE-Proton9-27.tar.gz");
  });
});
