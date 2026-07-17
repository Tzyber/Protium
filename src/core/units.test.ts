import { describe, expect, it } from "vitest";
import { builtinProtonToolName, isBlocked } from "../../src/core/blocklist.js";
import { parseCompatToolMapping } from "../../src/core/compat.js";
import { parseLibraryFolders } from "../../src/core/libraryfolders.js";
import { parseManifest } from "../../src/core/manifest.js";
import { isFullyInstalled } from "../../src/core/types.js";

const acf = (flags: number) => `"AppState"
{
	"appid"		"620"
	"name"		"Portal 2"
	"StateFlags"		"${flags}"
	"SizeOnDisk"		"12345678"
}`;

describe("StateFlags (S-2 bitfield)", () => {
  it("wert 4 = installiert", () => expect(isFullyInstalled(4)).toBe(true));
  it("wert 6 (installiert + update-pending) = installiert", () =>
    expect(isFullyInstalled(6)).toBe(true));
  it("wert 2 (nur update-pending) = nicht installiert", () =>
    expect(isFullyInstalled(2)).toBe(false));
  it("wert 0 = nicht installiert", () => expect(isFullyInstalled(0)).toBe(false));
});

describe("parseManifest", () => {
  it("liest felder + installed aus flags 6", () => {
    const m = parseManifest(acf(6));
    expect(m).toEqual({ appId: 620, name: "Portal 2", sizeBytes: 12345678, installed: true });
  });
  it("wirft bei fehlender appid", () => {
    expect(() => parseManifest('"AppState" { "name" "x" }')).toThrow();
  });
});

describe("blocklist", () => {
  it("blockt bekannte proton-appid", () =>
    expect(isBlocked(1493710, "Proton Experimental")).toBe(true));
  it("blockt via namens-heuristik", () =>
    expect(isBlocked(4242, "Steam Linux Runtime 3.0")).toBe(true));
  it("lässt echtes spiel durch", () => expect(isBlocked(620, "Portal 2")).toBe(false));
  it("liefert built-in-tool-name für FR-4.2", () =>
    expect(builtinProtonToolName(1493710)).toBe("proton_experimental"));
});

describe("parseCompatToolMapping (case-insensitive traversal)", () => {
  it("liest mapping trotz gemischter groß-/kleinschreibung", () => {
    const cfg = `"InstallConfigStore"
{
	"software"
	{
		"valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
					"620"
					{
						"name"		"GE-Proton9-27"
					}
					"570"
					{
						"name"		"proton_experimental"
					}
				}
			}
		}
	}
}`;
    const map = parseCompatToolMapping(cfg);
    expect(map.get(620)).toBe("GE-Proton9-27");
    expect(map.get(570)).toBe("proton_experimental");
    expect(map.size).toBe(2);
  });
  it("fehlender teilbaum → leere map", () => {
    expect(parseCompatToolMapping('"InstallConfigStore"\n{\n}').size).toBe(0);
  });
});

describe("parseLibraryFolders", () => {
  it("extrahiert alle library-pfade", () => {
    const lf = `"libraryfolders"
{
	"0"
	{
		"path"		"/home/u/.local/share/Steam"
	}
	"1"
	{
		"path"		"/mnt/games/SteamLibrary"
	}
}`;
    expect(parseLibraryFolders(lf)).toEqual([
      "/home/u/.local/share/Steam",
      "/mnt/games/SteamLibrary",
    ]);
  });
});
