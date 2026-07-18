import { describe, expect, it } from "vitest";
import { ProtonDbClient } from "../../src/core/protondb.js";
import { fakeHttp, memCache } from "../../tests/support/fakeSteam";

const summary = (tier: string, confidence = "strong") => ({
  status: 200,
  ok: true,
  text: JSON.stringify({ tier, confidence }),
  headers: {},
});

const url = (id: number) => `https://www.protondb.com/api/v1/reports/summaries/${id}.json`;

describe("ProtonDbClient", () => {
  it("mappt gültigen tier + confidence", async () => {
    const c = new ProtonDbClient(fakeHttp({ [url(620)]: summary("gold") }), memCache());
    expect(await c.getSummary(620)).toEqual({ tier: "gold", confidence: "strong" });
  });

  it("404 → null (→ aufrufer setzt unknown, INV-3)", async () => {
    const c = new ProtonDbClient(fakeHttp(), memCache());
    expect(await c.getSummary(1)).toBeNull();
  });

  it("unbekannter tier-string → 'unknown'", async () => {
    const c = new ProtonDbClient(fakeHttp({ [url(9)]: summary("diamond") }), memCache());
    expect((await c.getSummary(9))?.tier).toBe("unknown");
  });

  it("cache-hit vermeidet zweiten http-call innerhalb TTL", async () => {
    let calls = 0;
    const http = {
      async get(_u: string) {
        calls++;
        return summary("platinum");
      },
    };
    const c = new ProtonDbClient(http, memCache());
    await c.getSummary(570);
    await c.getSummary(570);
    expect(calls).toBe(1);
  });

  it("abgelaufener cache-eintrag → refetch", async () => {
    let calls = 0;
    const http = {
      async get() {
        calls++;
        return summary("silver");
      },
    };
    let t = 0;
    const c = new ProtonDbClient(http, memCache(), () => t);
    await c.getSummary(730);
    t = 8 * 24 * 60 * 60 * 1000; // > 7 tage
    await c.getSummary(730);
    expect(calls).toBe(2);
  });
});
