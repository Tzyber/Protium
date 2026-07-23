import { describe, expect, it } from "vitest";
import { availableBuiltinProtons, BLOCKLIST, isBlocked } from "../../src/core/blocklist.js";
import { parseCompatToolMapping } from "../../src/core/compat.js";
import { parseLibraryFolders } from "../../src/core/libraryfolders.js";
import { parseManifest } from "../../src/core/manifest.js";
import { joinPath } from "../../src/core/paths.js";
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
});

// one source of truth: BLOCKLIST ist die kanonische tabelle. der dropdown-flow
// (GameDetailDrawer.compatOptions) liest via availableBuiltinProtons aus
// derselben liste. ein zukünftiger split — z. b. eine separate appId→toolName-map
// für das dropdown — würde diese invariant brechen und der test schlägt fehl.
describe("kanonische tabelle (blocklist ↔ dropdown-flow)", () => {
  it("jeder proton-builtin-eintrag erscheint mit identischem toolnamen im dropdown", () => {
    for (const entry of BLOCKLIST) {
      if (entry.category !== "proton-builtin") continue;
      const installed = new Set([entry.appId]);
      const dropdown = availableBuiltinProtons(installed);
      const match = dropdown.find((d) => d.internalName === entry.toolName);
      expect(
        match,
        `appId ${entry.appId} (${entry.label}) muss mit toolName "${entry.toolName}" im dropdown auftauchen`,
      ).toBeDefined();
      expect(match?.displayName).toBe(entry.label);
    }
  });

  it("kein dropdown-eintrag ohne korrespondierenden blocklist-eintrag", () => {
    // umgekehrte richtung: der dropdown darf nichts erfinden, was nicht in
    // BLOCKLIST steht (würde eine zweite tabelle für die dropdown-daten bedeuten).
    const builtinToolNames = new Set(
      BLOCKLIST.filter((e) => e.category === "proton-builtin").map((e) => e.toolName),
    );
    const allInstalled = new Set(
      BLOCKLIST.filter((e) => e.category === "proton-builtin").map((e) => e.appId),
    );
    const dropdown = availableBuiltinProtons(allInstalled);
    for (const d of dropdown) {
      expect(
        builtinToolNames.has(d.internalName),
        `dropdown liefert toolName "${d.internalName}", der nicht in BLOCKLIST steht`,
      ).toBe(true);
    }
  });
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

describe("joinPath (path-traversal-rejection)", () => {
  it("verbietet .. in segmenten", () => {
    expect(() => joinPath("/home", "..", "etc")).toThrow("..");
  });

  it("verbietet .. am anfang", () => {
    expect(() => joinPath("/foo", "..")).toThrow("..");
  });

  it("verbietet .. in mehrteiligem segment", () => {
    expect(() => joinPath("/a/b", "c/../../etc")).toThrow("..");
  });

  it("erlaubt normale pfade", () => {
    expect(joinPath("/home/u", ".local", "share")).toBe("/home/u/.local/share");
  });

  it("erlaubt externe mount-pfade", () => {
    expect(joinPath("/run/media/user", "SteamLibrary")).toBe("/run/media/user/SteamLibrary");
    expect(joinPath("/mnt", "games")).toBe("/mnt/games");
  });
});
