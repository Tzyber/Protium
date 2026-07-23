import { joinPath, paths } from "./paths.js";
import type { DirEntry, FileSystem } from "./ports.js";

export const SHORTCUT_ID_THRESHOLD = 2_147_483_648; // 2^31

export type ShortcutResult =
  | { status: "none" }
  | { status: "ok"; ids: Set<number> }
  | { status: "unreadable"; paths: string[]; detail?: string };

// ---- binär-VDF-minimalparser (nur appid-extraktion) ----
// format: TYPE-KEY-VALUE (typ-byte VOR dem key-string)

const td = new TextDecoder();

class BinVdfError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BinVdfError";
  }
}

function readCString(buf: Uint8Array, pos: number): { str: string; next: number } {
  const end = buf.indexOf(0, pos);
  if (end === -1) throw new BinVdfError("unterminated string");
  return { str: td.decode(buf.slice(pos, end)), next: end + 1 };
}

function readU32(buf: Uint8Array, pos: number): { value: number; next: number } {
  if (pos + 4 > buf.length) throw new BinVdfError("truncated uint32");
  const dv = new DataView(buf.buffer, buf.byteOffset + pos, 4);
  return { value: dv.getUint32(0, true), next: pos + 4 };
}

/**
 * überspringt den wert ab `pos` (type-byte wurde bereits konsumiert).
 * rekursiv für type 0x00 (MAP). TYPE-KEY-VALUE-ordnung.
 */
function skipBinaryValue(buf: Uint8Array, pos: number, type: number): number {
  switch (type) {
    case 0x00: {
      let depth = 1;
      while (pos < buf.length && depth > 0) {
        if (buf[pos] === 0x08) {
          pos++;
          depth--;
          continue;
        }
        if (pos >= buf.length) throw new BinVdfError("truncated in nested object");
        const childType = buf[pos];
        pos++;
        if (childType === 0x08) {
          depth--;
          continue;
        }
        const key = readCString(buf, pos);
        pos = key.next;
        pos = skipBinaryValue(buf, pos, childType);
      }
      return pos;
    }
    case 0x01:
      return readCString(buf, pos).next;
    case 0x02:
    case 0x03:
    case 0x04:
      return pos + 4;
    case 0x05:
      return pos + 8;
    case 0x06:
    case 0x07: {
      const { value: len, next } = readU32(buf, pos);
      const skip = type === 0x07 ? len + 4 : len;
      return next + skip;
    }
    default:
      throw new BinVdfError(`unknown type 0x${type.toString(16)}`);
  }
}

/**
 * liest einen MAP-body. `pos` zeigt auf das erste child-typ-byte.
 * ruft `onEntry(appid)` für jeden eintrag mit numerischem key + appid.
 */
function parseMapBody(buf: Uint8Array, pos: number, onEntry: (appId: number) => void): number {
  while (pos < buf.length) {
    if (buf[pos] === 0x08) return pos + 1; // MAP ende
    const childType = buf[pos];
    pos++;
    if (childType === 0x08) return pos;
    const childKey = readCString(buf, pos);
    pos = childKey.next;

    if (childType === 0x00 && /^\d+$/.test(childKey.str)) {
      const { next } = parseEntryBody(buf, pos, onEntry);
      pos = next;
    } else {
      pos = skipBinaryValue(buf, pos, childType);
    }
  }
  throw new BinVdfError("unterminated map body");
}

/**
 * liest den MAP-body eines eintrags (z. B. "0"). extrahiert appid.
 * `pos` zeigt auf das erste child-typ-byte im eintrag-body.
 */
function parseEntryBody(
  buf: Uint8Array,
  pos: number,
  onEntry: (appId: number) => void,
): { next: number } {
  while (pos < buf.length) {
    if (buf[pos] === 0x08) return { next: pos + 1 };
    const valType = buf[pos];
    pos++;
    if (valType === 0x08) return { next: pos };
    const key = readCString(buf, pos);
    pos = key.next;

    if (key.str.toLowerCase() === "appid" && valType === 0x02) {
      const { value, next } = readU32(buf, pos);
      if (value > 0) onEntry(value);
      pos = next;
    } else {
      pos = skipBinaryValue(buf, pos, valType);
    }
  }
  throw new BinVdfError("unterminated entry body");
}

/**
 * extrahiert appIds aus binärem shortcuts.vdf.
 * wirft BinVdfError bei strukturbruch — caller entscheidet "unreadable".
 */
function parseBinaryShortcutIds(buf: Uint8Array): Set<number> {
  const ids = new Set<number>();
  if (buf.length === 0 || buf[0] !== 0x00) throw new BinVdfError("missing magic byte");

  let pos = 1;
  const root = readCString(buf, pos);
  pos = root.next;
  if (root.str.toLowerCase() !== "shortcuts")
    throw new BinVdfError(`unexpected root key: ${root.str}`);

  // root-body: TYPE-KEY-VALUE kinder. nur 0x00 (MAP) mit numerischem key interessiert uns.
  parseMapBody(buf, pos, (appId) => ids.add(appId));
  return ids;
}

// ---- filesystem-integration ----

export async function readAllShortcutAppIds(
  fs: FileSystem,
  steamRoot: string,
): Promise<ShortcutResult> {
  const ids = new Set<number>();
  const unreadable: string[] = [];
  let anyExists = false;

  const dir = paths.userdataDir(steamRoot);
  let dirExists: boolean;
  try {
    dirExists = await fs.exists(dir);
  } catch (e) {
    return { status: "unreadable", paths: [], detail: (e as Error).message };
  }
  if (!dirExists) return { status: "none" };

  let entries: DirEntry[];
  try {
    entries = await fs.readDir(dir);
  } catch (e) {
    return { status: "unreadable", paths: [], detail: (e as Error).message };
  }

  for (const entry of entries) {
    if (!entry.isDirectory || !/^\d+$/.test(entry.name)) continue;
    const scPath = joinPath(dir, entry.name, "config", "shortcuts.vdf");
    if (!(await fs.exists(scPath))) continue;

    anyExists = true;
    try {
      const buf = await fs.readFile(scPath);
      const shortcutIds = parseBinaryShortcutIds(buf);
      for (const id of shortcutIds) ids.add(id);
    } catch {
      unreadable.push(scPath);
    }
  }

  if (unreadable.length > 0) return { status: "unreadable", paths: unreadable };
  if (!anyExists) return { status: "none" };
  return { status: "ok", ids };
}

export { parseBinaryShortcutIds };
