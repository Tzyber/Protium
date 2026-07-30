import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSteamRoot } from "../../src/core/paths.js";
import { SteamNotFoundError } from "../../src/core/types.js";
import { nodeFs } from "../support/fakeSteam";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await import("node:fs/promises").then((fs) => fs.rm(d, { recursive: true, force: true }));
  }
  dirs = [];
});

async function tmpHome(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "protium-paths-"));
  dirs.push(d);
  return d;
}

describe("discoverSteamRoot", () => {
  it("findet native installation unter .local/share/Steam", async () => {
    const home = await tmpHome();
    const root = join(home, ".local/share/Steam");
    await mkdir(join(root, "steamapps"), { recursive: true });

    const found = await discoverSteamRoot(nodeFs(), home);
    expect(found).toBe(root);
  });

  it("findet flatpak-installation", async () => {
    const home = await tmpHome();
    const root = join(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam");
    await mkdir(join(root, "steamapps"), { recursive: true });

    const found = await discoverSteamRoot(nodeFs(), home);
    expect(found).toBe(root);
  });

  it("findet snap-installation", async () => {
    const home = await tmpHome();
    const root = join(home, "snap/steam/common/.local/share/Steam");
    await mkdir(join(root, "steamapps"), { recursive: true });

    const found = await discoverSteamRoot(nodeFs(), home);
    expect(found).toBe(root);
  });

  it("native hat priorität vor snap", async () => {
    const home = await tmpHome();
    const native = join(home, ".local/share/Steam");
    const snap = join(home, "snap/steam/common/.local/share/Steam");
    await mkdir(join(native, "steamapps"), { recursive: true });
    await mkdir(join(snap, "steamapps"), { recursive: true });

    const found = await discoverSteamRoot(nodeFs(), home);
    expect(found).toBe(native);
  });

  it("native hat priorität vor flatpak", async () => {
    const home = await tmpHome();
    const native = join(home, ".local/share/Steam");
    const flatpak = join(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam");
    await mkdir(join(native, "steamapps"), { recursive: true });
    await mkdir(join(flatpak, "steamapps"), { recursive: true });

    const found = await discoverSteamRoot(nodeFs(), home);
    expect(found).toBe(native);
  });

  it("flatpak hat priorität vor snap", async () => {
    const home = await tmpHome();
    const flatpak = join(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam");
    const snap = join(home, "snap/steam/common/.local/share/Steam");
    await mkdir(join(flatpak, "steamapps"), { recursive: true });
    await mkdir(join(snap, "steamapps"), { recursive: true });

    const found = await discoverSteamRoot(nodeFs(), home);
    expect(found).toBe(flatpak);
  });

  it("wirft SteamNotFoundError wenn nichts existiert", async () => {
    const home = await tmpHome();
    // keine steam-verzeichnisse anlegen

    await expect(discoverSteamRoot(nodeFs(), home)).rejects.toThrowError(SteamNotFoundError);
  });

  it(".steam/steam symlink wird via realpath aufgelöst", async () => {
    const home = await tmpHome();
    const real = join(home, ".local/share/Steam");
    const sym = join(home, ".steam/steam");
    await mkdir(join(real, "steamapps"), { recursive: true });
    await mkdir(join(home, ".steam"), { recursive: true });
    await symlink(real, sym, "dir");

    const found = await discoverSteamRoot(nodeFs(), home);
    expect(found).toBe(real);
  });
});
