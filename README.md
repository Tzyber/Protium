# protium

**deutsch** · [english](README.en.md)

[![CI](https://github.com/Tzyber/Protium/actions/workflows/ci.yml/badge.svg)](https://github.com/Tzyber/Protium/actions/workflows/ci.yml)

> ein proton. ein elektron. das simpelste atom im universum, und ungefähr so viel overhead soll auch dieses tool haben.

> Claude — Contributor: spirituell. Commits: nicht nachweisbar.

protium ist eine linux-desktop-app für steam/proton-housekeeping. sie zeigt dir, was auf deinem system wirklich los ist: welche spiele über welche proton-version laufen, wie die auf protondb bewertet sind, welche GE-proton-versionen ungenutzt platz fressen und welche verwaisten prefixes von längst deinstallierten spielen noch gigabytes belegen.

entstanden, weil es genau dieses tool nicht gab. protonup-qt managt nur versionen, protontricks ist ein winetricks-wrapper, steamtinkerlaunch kann alles und ist genau deshalb unübersichtlich. protium bündelt diese Aufgaben in einer Oberfläche.

![library-ansicht: cover-grid mit protondb-tiers, proton-zuordnung und filtern](docs/screenshots/main_page.png)

![proton-manager: installierte versionen mit nutzung, GE-releases zum installieren](docs/screenshots/proton_page.png)

![cleanup-ansicht: tabs für shader-caches, wine-prefixes und papierkorb](docs/screenshots/cleanup_view.png)

## was es kann

**library-übersicht.** alle spiele über alle libraries (auch auf externen platten), mit cover, größe, zugewiesener proton-version und protondb-tier direkt auf der karte. cover kommen aus steams lokalem librarycache, die app funktioniert also auch komplett offline.

**GE-proton-manager.** installierte versionen mit größe und der info, welche spiele sie tatsächlich nutzen. neue releases direkt von github installieren (streaming-download mit sha512-prüfung, abbrechbar, mit aufräumen der partiellen datei), ungenutzte löschen. distro-protons wie proton-cachyos werden erkannt und als read-only markiert — die gehören dem paketmanager, nicht uns.

**compat-tool + launch-options.** proton-version und startoptionen pro spiel direkt setzen. write-gate (steam-läuft-check → backup → atomarer rename), und ein chirurgischer vdf-string-patch statt voll-serialisierung, weil steams escaping und schlüsselreihenfolge sonst nicht erhalten bleiben.

**cleanup.** verwaiste wine-prefixes und shader-caches finden und bereinigen, in drei getrennten bereichen: shader-caches, wine-prefixes, papierkorb. shader-caches werden hart gelöscht, prefixes wandern in den papierkorb Prefixes werden innerhalb desselben Dateisystems in den Papierkorb verschoben. Erst beim Leeren wird Speicherplatz freigegeben.

**fehlerfälle.** nicht verfügbare oder unlesbare Daten werden als solche angezeigt. Bei schreibenden und löschenden Aktionen fragt protium vorher nach und legt, wo möglich, einen Rückweg an.

**spiele starten.** via `steam://rungameid/<appId>` — kein eigener launcher, keine prozess-überwachung.

**bedienbarkeit.** vollständig mit der tastatur bedienbar, sichtbare focus-states, tabs nach WAI-ARIA-pattern (pfeiltasten, roving tabindex), kontraste auf WCAG-AA geprüft, `prefers-reduced-motion` global respektiert. schriftgrößen in `rem`, damit die app mit der system-schriftgröße mitwächst. oberfläche auf deutsch und englisch, key-parität durch einen test abgesichert.

### prefix aus dem papierkorb zurückholen

protium hat bewusst **keine** wiederherstellungs-funktion: sobald ein spiel neu installiert ist, existiert `compatdata/<appId>` wieder, und ein automatisches zurückschieben müsste entscheiden, welcher stand gilt. dazu kommt, dass ein prefix von einer anderen proton-version stammen kann als die aktuell eingestellte. das sind entscheidungen für den menschen, nicht für ein tool.

von hand ist es ein `mv`. der papierkorb liegt in derselben library, der eintrag heisst `compatdata_<appId>_<zeitstempel>`:

```sh
cd /pfad/zur/SteamLibrary/steamapps
ls .protium-trash                       # eintrag finden
mv .protium-trash/compatdata_1477940_1785071505657 compatdata/1477940
```

wichtig: das ziel `compatdata/<appId>` darf nicht schon existieren. tut es das, hast du zwei stände — dann erst den vorhandenen wegsichern und danach entscheiden. steam legt einen fehlenden prefix beim nächsten spielstart selbst neu an (dann ohne die alten spielstände).

## warum kein bestehendes tool

Der Zweck ist, diese Informationen an einer Stelle sichtbar zu machen. Der erste Scan zeigte bereits Unterschiede zwischen der erwarteten und der tatsächlich verwendeten Proton-Konfiguration.

## stack

tauri v2 als shell, vue 3 + typescript für UI und domänenlogik, rust nur für das, was die webview nicht darf. kein electron, das binary bleibt klein und nutzt die system-webview (webkit2gtk).

Konkret übernimmt Rust nur: unter 1000 produktive zeilen rust — pfad-validierung, streaming-downloads mit hash, tarball-extraktion, die beiden löschbefehle, prozess-check, fs-scope-freigabe. Geschäftslogik und UI-Entscheidungen liegen nicht in dieser Schicht. dazu fast doppelt so viele zeilen tests wie produktivcode. Diese Pfade verändern oder löschen Dateien und sind deshalb separat getestet.

die domänenlogik in `src/core/` ist komplett UI-frei und redet mit dem system nur über ports/adapter. dadurch läuft die gesamte core-testsuite headless gegen fixtures, ohne tauri, ohne steam, ohne netz.

## dev-setup

voraussetzungen (cachyos/arch):

```sh
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl librsvg
rustup default stable   # falls rust fehlt: sudo pacman -S rustup
```

dann:

```sh
npm install
npm test              # vitest — core headless gegen fixtures
npm run check         # biome (lint + format) + vue-tsc --noEmit
(cd src-tauri && cargo test)   # rust: download-pfade, pfad-validierung, tarball-extraktion, cleanup/papierkorb
npm run tauri dev     # app starten (erster build kompiliert rust, dauert etwas)
```

`npm run check` und `npm test` laufen zusätzlich in der CI bei jedem push und pull request. der tauri-build läuft dort **nicht** — der braucht systemabhängigkeiten (webkit2gtk) und ist ein eigener schritt.

cache liegt unter `~/.cache/com.protium.desktop/`.

### abhängigkeiten und advisories

```sh
(cd src-tauri && cargo audit)
```

`src-tauri/audit.toml` listet advisories, die bewusst getragen werden — jeweils per ID mit begründung, damit ein **neuer** advisory weiterhin anschlägt. betrifft im wesentlichen tauris GTK3-stack (die gtk-rs-bindings sind unmaintained, gtk-rs ist auf GTK4 umgezogen) und build-time-only-crates. wiedervorlage, sobald tauri auf gtk-rs 0.20 geht.

## struktur

```
src/core/       domänenlogik, UI-frei. redet nur über ports
src/core/adapters/tauri.ts   ports gegen plugin-fs/http + rust-commands
src/ui/         vue-app: library, proton-manager, cleanup, i18n (de/en)
src-tauri/      rust-commands (extract, download, prozess-check, dir-size, fs-scope, löschpfade)
tests/          vitest gegen fake-steam-fixtures
docs/           screenshots, smoke-checkliste
```

Für die Implementierung gelten folgende Regeln: schreibende zugriffe auf steam-dateien laufen ausnahmslos durch ein write-gate (steam-läuft-check, backup, atomarer write). destruktive aktionen fragen immer nach und zeigen konkret, was passieren würde. wo pfadwissen gebraucht wird, kommt es aus `paths.ts` und nicht aus zusammengebauten strings. netzwerkausfall darf features verarmen, aber nie die app blockieren. Kann ein Wert nicht zuverlässig bestimmt werden, zeigt die App `unbekannt` an.

## roadmap

- [x] phase 1: core data layer (scan, vdf-parsing, protondb, multi-library inkl. externer mounts)
- [x] phase 2: library-UI (cover-grid, tiers, warnings, such/filter/sort)
- [x] phase 3: GE-proton-manager (install/remove, queue, distro-tool-erkennung, downloads abbrechen inkl. aufräumen)
- [x] game-detail-drawer mit protondb-link (reports anderer nutzer)
- [x] phase 4: compat-tool und launch-options setzen (write-gate, backups, vdf-string-patch)
- [x] phase 5: cleanup verwaister prefixes und shader-caches + papierkorb
- [x] spiele starten (via steam-protokoll, kein eigener launcher)
- [x] i18n (deutsch/englisch)
- [x] CI: lint, typecheck und tests bei jedem push
- [ ] phase 6: release — AppImage-build in der CI, danach AUR-paket

## status

in aktiver entwicklung. api und UI ändern sich ohne vorwarnung. wer das liest, bevor version 0.1 existiert: Die Roadmap beschreibt den aktuellen Stand; sie ist keine Zusage für kommende Versionen.
