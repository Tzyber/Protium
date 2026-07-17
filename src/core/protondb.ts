import type { Cache, Http } from "./ports.js";
import type { Tier } from "./types.js";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VALID_TIERS: readonly Tier[] = ["platinum", "gold", "silver", "bronze", "borked", "unknown"];

// host wird in S-3 gegen echte requests fixiert (www vs apex + redirects);
// muss dem http-scope in §2 entsprechen, sonst blockt tauri den request.
const BASE = "https://www.protondb.com/api/v1/reports/summaries";

interface CacheEntry {
  tier: Tier;
  confidence: string;
  fetchedAt: number;
}

function normalizeTier(raw: unknown): Tier {
  return typeof raw === "string" && (VALID_TIERS as string[]).includes(raw)
    ? (raw as Tier)
    : "unknown";
}

export class ProtonDbClient {
  constructor(
    private http: Http,
    private cache: Cache,
    private now: () => number = Date.now,
  ) {}

  /**
   * tier für eine appId. cache-hit (frisch) → sofort; sonst netzwerk.
   * 404 / offline / kaputte antwort → null (aufrufer setzt tier "unknown", INV-3).
   */
  async getSummary(appId: number): Promise<{ tier: Tier; confidence: string } | null> {
    const key = `protondb:${appId}`;
    try {
      const cached = await this.cache.get(key);
      if (cached) {
        const entry = JSON.parse(cached) as CacheEntry;
        if (this.now() - entry.fetchedAt < TTL_MS) {
          return { tier: entry.tier, confidence: entry.confidence };
        }
      }
    } catch {
      // kaputter cache-eintrag → wie miss behandeln
    }

    try {
      const res = await this.http.get(`${BASE}/${appId}.json`);
      if (!res.ok) return null; // insb. 404 = kein report
      const body = JSON.parse(res.text) as { tier?: unknown; confidence?: unknown };
      const result = {
        tier: normalizeTier(body.tier),
        confidence: typeof body.confidence === "string" ? body.confidence : "unknown",
      };
      const entry: CacheEntry = { ...result, fetchedAt: this.now() };
      await this.cache.set(key, JSON.stringify(entry));
      return result;
    } catch {
      return null; // netzwerkfehler → degradieren
    }
  }
}
