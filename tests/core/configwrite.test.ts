import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SteamRunningError, writeSteamFile } from "../../src/core/configwrite.js";
import { fakeSystem, nodeFs } from "../support/fakeSteam.js";

const tmp = () => mkdtemp(join(tmpdir(), "protium-writegate-"));

describe("writeSteamFile (INV-1 write-gate)", () => {
  it("blockt bei laufendem steam — datei unangetastet, kein backup", async () => {
    const dir = await tmp();
    const target = join(dir, "localconfig.vdf");
    await writeFile(target, "ORIGINAL", "utf8");
    const system = { ...fakeSystem(), isProcessRunning: async () => true };

    await expect(
      writeSteamFile(nodeFs(), system, target, "NEU", join(dir, "backups"), "IRRELEVANT"),
    ).rejects.toBeInstanceOf(SteamRunningError);
    expect(await readFile(target, "utf8")).toBe("ORIGINAL");
    expect(await readdir(dir)).toEqual(["localconfig.vdf"]); // weder backup-dir noch temp
  });

  it("schreibt atomar: backup mit altstand, temp weg, ziel neu", async () => {
    const dir = await tmp();
    const target = join(dir, "localconfig.vdf");
    await writeFile(target, "ORIGINAL", "utf8");
    const backupDir = join(dir, "tief", "verschachtelt", "backups"); // mkdir muss rekursiv können

    await writeSteamFile(nodeFs(), fakeSystem(), target, "NEU", backupDir, "ORIGINAL");

    expect(await readFile(target, "utf8")).toBe("NEU");
    const backups = await readdir(backupDir);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^localconfig\.vdf\.\d{4}-\d{2}-\d{2}T/);
    const backupFile = backups[0];
    if (!backupFile) throw new Error("backup fehlt");
    expect(await readFile(join(backupDir, backupFile), "utf8")).toBe("ORIGINAL");
    expect(await readdir(dir)).not.toContain("localconfig.vdf.protium-tmp");
  });

  it("ohne bestehende zieldatei: schreibt ohne backup", async () => {
    const dir = await tmp();
    const target = join(dir, "neu.vdf");
    const backupDir = join(dir, "backups");

    await writeSteamFile(nodeFs(), fakeSystem(), target, "INHALT", backupDir, "IRRELEVANT");

    expect(await readFile(target, "utf8")).toBe("INHALT");
    expect(await readdir(dir)).toEqual(["neu.vdf"]); // kein backup-dir angelegt
  });

  it("backupText-parameter: backup = übergebener text, NICHT disk-re-read (TOCTOU-schutz)", async () => {
    const dir = await tmp();
    const target = join(dir, "localconfig.vdf");
    await writeFile(target, "ORIGINAL", "utf8");
    const backupDir = join(dir, "backups");

    // simuliere: zwischen dem read des callers und writeSteamFile wurde die datei
    // extern auf "FREMD" geändert. mit backupText="ORIGINAL" muss das backup
    // trotzdem "ORIGINAL" enthalten (nicht "FREMD" von der disk).
    await writeSteamFile(nodeFs(), fakeSystem(), target, "NEU", backupDir, "ORIGINAL");
    // jetzt die disk auf "FREMD" ändern — wird ignoriert weil backupText gegeben
    await writeFile(target, "FREMD", "utf8");
    // backup sollte "ORIGINAL" sein

    const backups = await readdir(backupDir);
    expect(backups).toHaveLength(1);
    const backupFile = backups[0];
    if (!backupFile) throw new Error("backup fehlt");
    expect(await readFile(join(backupDir, backupFile), "utf8")).toBe("ORIGINAL");
  });
});
