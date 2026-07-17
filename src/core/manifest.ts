import { isFullyInstalled } from "./types.js";
import { asInt, asString, getKeyInsensitive, parseVdf } from "./vdf.js";

export interface ManifestData {
  appId: number;
  name: string;
  sizeBytes: number;
  installed: boolean;
}

/**
 * parst eine appmanifest_*.acf. wirft bei kaputtem inhalt / fehlender appid —
 * der aufrufer (scan) fängt das ab und degradiert zu skip+warning (INV-2).
 */
export function parseManifest(text: string): ManifestData {
  const root = parseVdf(text);
  const app = getKeyInsensitive(root, "AppState");
  if (typeof app !== "object" || app === null) {
    throw new Error("appmanifest ohne AppState-block");
  }
  const appId = asInt(getKeyInsensitive(app, "appid"));
  if (appId === undefined) throw new Error("appmanifest ohne gültige appid");

  const name = asString(getKeyInsensitive(app, "name")) ?? `app ${appId}`;
  const sizeBytes = asInt(getKeyInsensitive(app, "SizeOnDisk")) ?? 0;
  const stateFlags = asInt(getKeyInsensitive(app, "StateFlags")) ?? 0;

  return { appId, name, sizeBytes, installed: isFullyInstalled(stateFlags) };
}
