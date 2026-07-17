import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Cache,
  DirEntry,
  FileSystem,
  Http,
  HttpResponse,
  PathIdentity,
  System,
} from "../../src/core/ports.js";

// ---- fixtures als inhalt (fake-steam wächst pro phase, §6) ----

const acf = (appId: number, name: string, flags: number, size: number) => `"AppState"
{
	"appid"		"${appId}"
	"name"		"${name}"
	"StateFlags"		"${flags}"
	"SizeOnDisk"		"${size}"
}
`;

const CONFIG_VDF = `"InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
					"0"
					{
						"name"		"proton-cachyos-slr"
					}
					"620"
					{
						"name"		"GE-Proton9-27"
					}
					"730"
					{
						"name"		"proton-cachyos-slr"
					}
					"999999"
					{
						"name"		"proton-cachyos-slr"
					}
					"2207218128"
					{
						"name"		"proton-cachyos-slr"
					}
				}
			}
		}
	}
}
`;

const toolVdf = (internal: string, display: string) => `"compatibilitytools"
{
	"compat_tools"
	{
		"${internal}"
		{
			"install_path"		"."
			"display_name"		"${display}"
			"from_oslist"		"windows"
			"to_oslist"		"linux"
		}
	}
}
`;

/**
 * baut einen fake-steam-baum, der dominiks reales setup abbildet:
 *  - root-library + externer mount (lib2)
 *  - lib2Dup: symlink auf lib2 → muss per identität dedupliziert werden
 *  - staleLib: pfad in libraryfolders.vdf, der nicht existiert (nicht gemountet)
 *  - root compatibilitytools.d: GE + "Proton-CachyOS Latest" (interner name == dir, ungenutzt)
 *  - systemCompat (analog /usr/share/steam/…): "proton-cachyos-slr" (genutzt von 730)
 *  spiele: 570 (root, default), 620 (lib2, GE), 730 (lib2, cachyos-slr),
 *          1493710 (proton exp → gefiltert), 9999 (korrupt → warning)
 */
export async function buildFakeSteam(): Promise<{
  home: string;
  root: string;
  lib2: string;
  lib2Dup: string;
  staleLib: string;
  systemCompat: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "protium-"));
  const root = join(home, ".local/share/Steam");
  const lib2 = join(home, "mnt/games/SteamLibrary");
  const lib2Dup = join(home, "run/media/user/SteamLibrary"); // symlink → lib2
  const staleLib = join(home, "gone/SteamLibrary"); // nie angelegt
  const systemCompat = join(home, "usr/share/steam/compatibilitytools.d");

  await mkdir(join(root, "steamapps"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "compatibilitytools.d/GE-Proton9-27"), { recursive: true });
  await mkdir(join(root, "compatibilitytools.d/Proton-CachyOS Latest"), { recursive: true });
  await mkdir(join(lib2, "steamapps"), { recursive: true });
  await mkdir(join(home, "run/media/user"), { recursive: true });
  // lokaler bild-cache: appcache/librarycache/{appId}/{hash}/library_header.jpg
  const cacheHashDir = join(root, "appcache/librarycache/620/abc123hash");
  await mkdir(cacheHashDir, { recursive: true });
  await writeFile(join(cacheHashDir, "library_header.jpg"), "JPEGDATA");
  await symlink(lib2, lib2Dup, "dir");
  await mkdir(join(systemCompat, "proton-cachyos-slr"), { recursive: true });

  const libraryFolders = `"libraryfolders"
{
	"0" { "path" "${root}" }
	"1" { "path" "${lib2}" }
	"2" { "path" "${lib2Dup}" }
	"3" { "path" "${staleLib}" }
}`.replace(/\{ "path" "([^"]+)" \}/g, '\n\t{\n\t\t"path"\t\t"$1"\n\t}');
  await writeFile(join(root, "steamapps/libraryfolders.vdf"), libraryFolders);

  await writeFile(join(root, "steamapps/appmanifest_570.acf"), acf(570, "Dota 2", 6, 1610612736));
  await writeFile(
    join(root, "steamapps/appmanifest_1493710.acf"),
    acf(1493710, "Proton Experimental", 4, 500000000),
  );
  await writeFile(join(root, "steamapps/appmanifest_9999.acf"), '"AppState" { kaputt ohne close');
  await writeFile(join(root, "config/config.vdf"), CONFIG_VDF);
  await writeFile(
    join(root, "compatibilitytools.d/GE-Proton9-27/compatibilitytool.vdf"),
    toolVdf("GE-Proton9-27", "GE-Proton9-27"),
  );
  await writeFile(
    join(root, "compatibilitytools.d/Proton-CachyOS Latest/compatibilitytool.vdf"),
    toolVdf("Proton-CachyOS Latest", "Proton-CachyOS Latest"),
  );
  await writeFile(
    join(systemCompat, "proton-cachyos-slr/compatibilitytool.vdf"),
    toolVdf("proton-cachyos-slr", "proton-cachyos-11.0 (steam linux runtime)"),
  );

  await writeFile(join(lib2, "steamapps/appmanifest_620.acf"), acf(620, "Portal 2", 4, 12345678));
  await writeFile(
    join(lib2, "steamapps/appmanifest_730.acf"),
    acf(730, "Counter-Strike 2", 6, 98765432),
  );

  return { home, root, lib2, lib2Dup, staleLib, systemCompat };
}

// ---- port-adapter über node:fs (echtes dir-walking gegen fixtures) ----

export function nodeFs(): FileSystem {
  return {
    async exists(p) {
      try {
        await lstat(p);
        return true;
      } catch {
        return false;
      }
    },
    readTextFile: (p) => readFile(p, "utf8"),
    async readDir(p) {
      const entries = await readdir(p, { withFileTypes: true });
      return entries.map(
        (e): DirEntry => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          isSymlink: e.isSymbolicLink(),
        }),
      );
    },
    realpath: (p) => realpath(p),
    remove: (p, opts) => rm(p, { recursive: opts?.recursive ?? false, force: true }),
  };
}

/** system-port: allowLibraryScope protokolliert; pathIdentity via echtem stat. */
export function fakeSystem(): System & { scopedPaths: string[] } {
  const scopedPaths: string[] = [];
  return {
    scopedPaths,
    async isProcessRunning() {
      return false;
    },
    async dirSize() {
      return 4096;
    },
    async allowLibraryScope(p) {
      scopedPaths.push(p);
    },
    async pathIdentity(p): Promise<PathIdentity | null> {
      try {
        const rp = await realpath(p);
        const st = await stat(rp);
        return { realpath: rp, dev: String(st.dev), ino: String(st.ino) };
      } catch {
        return null;
      }
    },
    async downloadFile() {
      return ""; // in geproton-tests gezielt gemockt
    },
    async extractTarball() {},
  };
}

export function memCache(): Cache {
  const m = new Map<string, string>();
  return {
    async get(k) {
      return m.get(k) ?? null;
    },
    async set(k, v) {
      m.set(k, v);
    },
  };
}

/** http, das eine feste antwort pro url liefert; default 404 → tier unknown. */
export function fakeHttp(routes: Record<string, HttpResponse> = {}): Http {
  return {
    async get(url: string) {
      return routes[url] ?? { status: 404, ok: false, text: "", headers: {} };
    },
  };
}
