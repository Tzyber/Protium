import { asNode, asString, getKeyInsensitive, getPath, parseVdf } from "./vdf.js";

/**
 * moderne libraryfolders.vdf: "libraryfolders" → "0" → { "path" "..." }.
 * die root-library selbst ist als index-0 enthalten. gibt absolute pfade
 * dedupliziert zurück. tolerant gegen unbekannte keys (steam-format-drift).
 */
export function parseLibraryFolders(text: string): string[] {
  const root = parseVdf(text);
  const container =
    asNode(getKeyInsensitive(root, "libraryfolders")) ??
    asNode(getKeyInsensitive(root, "LibraryFolders"));
  if (!container) return [];

  const out: string[] = [];
  for (const key of Object.keys(container)) {
    if (!/^\d+$/.test(key)) continue; // nur numerische indizes
    const path = asString(getPath(container, key, "path"));
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}
