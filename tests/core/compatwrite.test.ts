import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeCompatTool, writeCompatTool } from "../../src/core/compatwrite.js";
import { SteamRunningError } from "../../src/core/configwrite.js";
import { getVdfValue } from "../../src/core/vdfpatch.js";
import { fakeSystem, nodeFs } from "../support/fakeSteam.js";

const tmp = () => mkdtemp(join(tmpdir(), "protium-compatwrite-"));

const CONFIG_VDF = `"InstallConfigStore"
{
\t"Software"
\t{
\t\t"Valve"
\t\t{
\t\t\t"Steam"
\t\t\t{
\t\t\t\t"CompatToolMapping"
\t\t\t\t{
\t\t\t\t\t"0"
\t\t\t\t\t{
\t\t\t\t\t\t"name"\t\t"proton-cachyos-slr"
\t\t\t\t\t}
\t\t\t\t\t"620"
\t\t\t\t\t{
\t\t\t\t\t\t"name"\t\t"GE-Proton9-27"
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

const C_PATH = ["InstallConfigStore", "Software", "Valve", "Steam", "CompatToolMapping"];

async function setupSteam(dir: string): Promise<string> {
  const root = join(dir, ".steam");
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config", "config.vdf"), CONFIG_VDF, "utf8");
  return root;
}

describe("writeCompatTool", () => {
  it("setzt name, config und priority im mapping", async () => {
    const dir = await tmp();
    const root = await setupSteam(dir);
    const backupDir = join(dir, "backups");
    const configPath = join(root, "config", "config.vdf");

    const result = await writeCompatTool(
      { fs: nodeFs(), system: fakeSystem() },
      root,
      730,
      "custom-proton-99",
      backupDir,
    );

    expect(result).toBe("written");
    const text = await readFile(configPath, "utf8");
    expect(getVdfValue(text, [...C_PATH, "730", "name"])).toBe("custom-proton-99");
    expect(getVdfValue(text, [...C_PATH, "730", "config"])).toBe("");
    expect(getVdfValue(text, [...C_PATH, "730", "priority"])).toBe("250");
  });

  it("no-op bei unverändertem tool → kein write, kein backup", async () => {
    const dir = await tmp();
    const root = await setupSteam(dir);
    const backupDir = join(dir, "backups");
    const configPath = join(root, "config", "config.vdf");
    const original = await readFile(configPath, "utf8");

    const result = await writeCompatTool(
      { fs: nodeFs(), system: fakeSystem() },
      root,
      620,
      "GE-Proton9-27",
      backupDir,
    );

    expect(result).toBe("unchanged");
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await readdir(backupDir).catch(() => [])).toEqual([]); // kein backup-dir angelegt
  });

  it("ändert ein bestehendes tool → setzt config + priority zusätzlich", async () => {
    const dir = await tmp();
    const root = await setupSteam(dir);
    const backupDir = join(dir, "backups");
    const configPath = join(root, "config", "config.vdf");

    // 620 hat im fixture nur "name" (kein config/priority) → tool-change muss beide ergänzen
    const result = await writeCompatTool(
      { fs: nodeFs(), system: fakeSystem() },
      root,
      620,
      "OtherTool",
      backupDir,
    );

    expect(result).toBe("written");
    const text = await readFile(configPath, "utf8");
    expect(getVdfValue(text, [...C_PATH, "620", "name"])).toBe("OtherTool");
    expect(getVdfValue(text, [...C_PATH, "620", "config"])).toBe("");
    expect(getVdfValue(text, [...C_PATH, "620", "priority"])).toBe("250");
    expect(getVdfValue(text, [...C_PATH, "0", "name"])).toBe("proton-cachyos-slr"); // nachbar unberührt
  });

  it("write → remove → block vollständig weg", async () => {
    const dir = await tmp();
    const root = await setupSteam(dir);
    const backupDir = join(dir, "backups");

    await writeCompatTool({ fs: nodeFs(), system: fakeSystem() }, root, 730, "tmp", backupDir);
    const result = await removeCompatTool(
      { fs: nodeFs(), system: fakeSystem() },
      root,
      730,
      backupDir,
    );

    expect(result).toBe("written");
    const text = await readFile(join(root, "config", "config.vdf"), "utf8");
    expect(getVdfValue(text, [...C_PATH, "730", "name"])).toBeUndefined();
    expect(getVdfValue(text, [...C_PATH, "620", "name"])).toBe("GE-Proton9-27");
  });

  it("TOCTOU: backupText = ursprünglicher text, auch wenn disk sich ändert", async () => {
    const dir = await tmp();
    const root = await setupSteam(dir);
    const backupDir = join(dir, "backups");
    const configPath = join(root, "config", "config.vdf");

    // simuliert parallelen externen write (z. B. steam): config.vdf wird
    // zwischen read und write von außen auf einen anderen validen stand geändert
    const altered = CONFIG_VDF.replace("GE-Proton9-27", "ExternalTool-1");
    await writeFile(configPath, altered, "utf8");

    // writeCompatTool liest jetzt "ExternalTool-1" text, setzt 730 → foo,
    // backup muss den tatsächlich gelesenen text enthalten
    const result = await writeCompatTool(
      { fs: nodeFs(), system: fakeSystem() },
      root,
      730,
      "foo",
      backupDir,
    );

    expect(result).toBe("written");
    const backups = await readdir(backupDir);
    expect(backups).toHaveLength(1);
    const backupText = await readFile(join(backupDir, backups[0]!), "utf8");
    expect(backupText).toContain("ExternalTool-1");
    expect(backupText).not.toContain("foo"); // backup = vor dem patch
  });

  it("write-gate: blockt bei laufendem steam", async () => {
    const dir = await tmp();
    const root = await setupSteam(dir);
    const backupDir = join(dir, "backups");
    const configPath = join(root, "config", "config.vdf");
    const original = await readFile(configPath, "utf8");
    const steamSystem = { ...fakeSystem(), isProcessRunning: async () => true };

    await expect(
      writeCompatTool({ fs: nodeFs(), system: steamSystem }, root, 730, "foo", backupDir),
    ).rejects.toBeInstanceOf(SteamRunningError);
    expect(await readFile(configPath, "utf8")).toBe(original);
  });
});

describe("removeCompatTool", () => {
  it("entfernt den appId-block aus dem mapping", async () => {
    const dir = await tmp();
    const root = await setupSteam(dir);
    const backupDir = join(dir, "backups");
    const configPath = join(root, "config", "config.vdf");

    const result = await removeCompatTool(
      { fs: nodeFs(), system: fakeSystem() },
      root,
      620,
      backupDir,
    );

    expect(result).toBe("written");
    const text = await readFile(configPath, "utf8");
    // 620 block weg, 0 bleibt
    expect(getVdfValue(text, [...C_PATH, "620", "name"])).toBeUndefined();
    expect(getVdfValue(text, [...C_PATH, "0", "name"])).toBe("proton-cachyos-slr");
  });

  it("no-op wenn kein mapping existiert", async () => {
    const dir = await tmp();
    const root = await setupSteam(dir);
    const backupDir = join(dir, "backups");
    const configPath = join(root, "config", "config.vdf");
    const original = await readFile(configPath, "utf8");

    const result = await removeCompatTool(
      { fs: nodeFs(), system: fakeSystem() },
      root,
      999,
      backupDir,
    );

    expect(result).toBe("unchanged");
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await readdir(backupDir).catch(() => [])).toEqual([]); // kein backup-dir angelegt
  });
});
