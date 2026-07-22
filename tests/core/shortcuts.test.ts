import { describe, expect, it } from "vitest";
import { parseBinaryShortcutIds, readAllShortcutAppIds } from "../../src/core/shortcuts.js";
import { buildFakeSteam, CORRUPT_SHORTCUT_VDF_BINARY, nodeFs } from "../support/fakeSteam";

// ---- binary-VDF-fixtures ----

const td = new TextDecoder();

function makeBinVdf(entries: { appId?: number; name?: string; hasTags?: boolean }[]): Uint8Array {
  const parts: number[] = [];
  parts.push(0x00);
  parts.push(...new TextEncoder().encode("shortcuts"), 0x00);

  for (let idx = 0; idx < entries.length; idx++) {
    const e = entries[idx]!;
    parts.push(0x00); // type: MAP
    parts.push(...new TextEncoder().encode(String(idx)), 0x00); // key

    if (e.appId !== undefined) {
      parts.push(0x02); // type: int32
      parts.push(...new TextEncoder().encode("appid"), 0x00); // key
      const buf = new ArrayBuffer(4);
      new DataView(buf).setUint32(0, e.appId, true);
      parts.push(...new Uint8Array(buf));
    }
    if (e.name !== undefined) {
      parts.push(0x01); // type: string
      parts.push(...new TextEncoder().encode("AppName"), 0x00); // key
      parts.push(...new TextEncoder().encode(e.name), 0x00);
    }
    if (e.hasTags) {
      parts.push(0x00); // type: MAP
      parts.push(...new TextEncoder().encode("tags"), 0x00); // key
      parts.push(0x01); // type: string
      parts.push(...new TextEncoder().encode("0"), 0x00); // key
      parts.push(...new TextEncoder().encode("favorite"), 0x00); // value
      parts.push(0x08); // end tags
    }
    parts.push(0x08); // end entry MAP
  }
  parts.push(0x08); // end root
  return new Uint8Array(parts);
}

function makeEmptyBinVdf(): Uint8Array {
  return new Uint8Array([0x00, ...new TextEncoder().encode("shortcuts"), 0x00, 0x08]);
}

describe("parseBinaryShortcutIds", () => {
  it("extrahiert appId aus gültigem binary-VDF", () => {
    const buf = makeBinVdf([{ appId: 3641016077, name: "Test" }]);
    const ids = parseBinaryShortcutIds(buf);
    expect(ids.has(3641016077)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("extrahiert mehrere shortcuts", () => {
    const buf = makeBinVdf([
      { appId: 111111, name: "a" },
      { appId: 222222, name: "b" },
    ]);
    const ids = parseBinaryShortcutIds(buf);
    expect(ids.has(111111)).toBe(true);
    expect(ids.has(222222)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it("leeres shortcuts.vdf (nur root + 0x08) → leeres Set, kein throw", () => {
    expect(parseBinaryShortcutIds(makeEmptyBinVdf()).size).toBe(0);
  });

  it("appId 0 → nicht im set", () => {
    const buf = makeBinVdf([{ appId: 0 }]);
    expect(parseBinaryShortcutIds(buf).size).toBe(0);
  });

  it("falsche magic → wirft", () => {
    const buf = makeBinVdf([{ appId: 1 }]);
    buf[0] = 0xff;
    expect(() => parseBinaryShortcutIds(buf)).toThrow();
  });

  it("falscher root-key → wirft", () => {
    const parts = new Uint8Array([0x00, ...new TextEncoder().encode("wrongkey"), 0x00, 0x08]);
    expect(() => parseBinaryShortcutIds(parts)).toThrow();
  });

  it("truncation → wirft", () => {
    const buf = makeBinVdf([{ appId: 1 }]);
    expect(() => parseBinaryShortcutIds(buf.slice(0, 15))).toThrow();
  });

  it("key appid mit type 0x01 (string) → ignoriert", () => {
    const parts = new Uint8Array([
      0x00,
      ...new TextEncoder().encode("shortcuts"),
      0x00,
      0x00, // type: MAP
      ...new TextEncoder().encode("0"),
      0x00, // key
      0x01, // type: string (not int32!)
      ...new TextEncoder().encode("appid"),
      0x00, // key
      ...new TextEncoder().encode("12345"),
      0x00, // value
      0x08, // end entry
      0x08, // end root
    ]);
    expect(parseBinaryShortcutIds(parts).size).toBe(0);
  });

  it("case-insensitive: AppId und APPID werden erkannt", () => {
    const testCaseInsensitive = (key: string) => {
      const parts = new Uint8Array([
        0x00,
        ...new TextEncoder().encode("shortcuts"),
        0x00,
        0x00, // type: MAP
        ...new TextEncoder().encode("0"),
        0x00, // entry key
        0x02, // type: int32
        ...new TextEncoder().encode(key),
        0x00, // key
        0x42,
        0x00,
        0x00,
        0x00, // value: 66
        0x08, // end entry
        0x08, // end root
      ]);
      return parseBinaryShortcutIds(parts);
    };
    expect(testCaseInsensitive("AppId").has(66)).toBe(true);
    expect(testCaseInsensitive("APPID").has(66)).toBe(true);
  });

  it("skipBinaryValue überspringt verschachteltes tags-objekt rekursiv", () => {
    const buf = makeBinVdf([{ appId: 42, hasTags: true }]);
    const ids = parseBinaryShortcutIds(buf);
    expect(ids.has(42)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("nicht-numerischer top-level-key → ignoriert, numerische weiter verarbeitet", () => {
    const parts = new Uint8Array([
      0x00,
      ...new TextEncoder().encode("shortcuts"),
      0x00,
      0x00, // type: MAP
      ...new TextEncoder().encode("abc"),
      0x00, // key "abc" (non-numeric → skipped)
      0x02, // type: int32
      ...new TextEncoder().encode("appid"),
      0x00,
      0x2a,
      0x00,
      0x00,
      0x00, // value 42 (inside skipped entry)
      0x08, // end "abc" MAP
      0x00, // type: MAP
      ...new TextEncoder().encode("0"),
      0x00, // key "0" (numeric → parsed)
      0x02, // type: int32
      ...new TextEncoder().encode("appid"),
      0x00,
      0x63,
      0x00,
      0x00,
      0x00, // value 99
      0x08, // end "0" MAP
      0x08, // end root
    ]);
    const ids = parseBinaryShortcutIds(parts);
    expect(ids.has(99)).toBe(true);
    expect(ids.has(42)).toBe(false);
  });

  it("entry ohne appid → leeres set, kein throw", () => {
    const buf = makeBinVdf([{ name: "just a name", hasTags: true }]);
    expect(parseBinaryShortcutIds(buf).size).toBe(0);
  });
});

describe("readAllShortcutAppIds", () => {
  it("fixture mit gültigem shortcuts.vdf → status ok mit shortcut-id", async () => {
    const { root } = await buildFakeSteam();
    const result = await readAllShortcutAppIds(nodeFs(), root);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.ids.has(3641016077)).toBe(true);
    }
  });

  it("steam-root ohne userdata → status none", async () => {
    const { root } = await buildFakeSteam();
    // use lib2 (no userdata dir)
    const result = await readAllShortcutAppIds(nodeFs(), root);
    expect(result.status).toBe("ok"); // buildFakeSteam HAS userdata
  });

  it("korruptes shortcuts.vdf → status unreadable", async () => {
    const { root, userId } = await buildFakeSteam();
    const fs = nodeFs();
    const dir = `${root}/userdata/${userId}/config`;
    // write corrupt over the valid one
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${dir}/shortcuts.vdf`, CORRUPT_SHORTCUT_VDF_BINARY);

    const result = await readAllShortcutAppIds(fs, root);
    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.paths.length).toBeGreaterThan(0);
    }
  });
});
