# protium

[deutsch](README.md) · **english**

[![CI](https://github.com/Tzyber/Protium/actions/workflows/ci.yml/badge.svg)](https://github.com/Tzyber/Protium/actions/workflows/ci.yml)

> one proton. one electron. the simplest atom in the universe, and roughly the amount of overhead this tool is meant to have.

> Claude — contributor: spiritually. commits: not traceable.

protium is a linux desktop app for steam/proton housekeeping. it shows you what is actually going on your system: which games run on which proton version, how those are rated on protondb, which GE-proton versions are eating space unused, and which orphaned prefixes from long-uninstalled games still occupy gigabytes.

it exists because this particular tool did not. protonup-qt only manages versions, protontricks is a winetricks wrapper, steamtinkerlaunch does everything and is unwieldy for exactly that reason. protium bundles these tasks in one surface.

![library view: cover grid with protondb tiers, proton assignment and filters](docs/screenshots/main_page.png)

![proton manager: installed versions with usage, GE releases to install](docs/screenshots/proton_page.png)

![cleanup view: tabs for shader caches, wine prefixes and trash](docs/screenshots/cleanup_view.png)

## what it does

**library overview.** every game across every library (external drives included), with cover art, size, assigned proton version and protondb tier right on the card. covers come from steam's local librarycache, so the app works fully offline.

**GE-proton manager.** installed versions with size and the information which games actually use them. install new releases straight from github (streaming download with sha512 verification, cancellable, partial file cleaned up), remove unused ones. distro protons such as proton-cachyos are detected and marked read-only — those belong to the package manager, not to us.

**compat tool + launch options.** set the proton version and launch options per game. write gate (steam-is-running check → backup → atomic rename), and a surgical vdf string patch instead of full serialisation, because otherwise steam's escaping and key order do not survive.

**cleanup.** find and clear orphaned wine prefixes and shader caches, in three separate areas: shader caches, wine prefixes, trash. shader caches are deleted outright, Prefixes are moved to the trash by renaming them within the same filesystem. Disk space is released only when the trash is emptied.

**failure cases.** unavailable or unreadable data is shown as such. Before writing or deleting, protium asks for confirmation and, where possible, keeps a way back.

**launching games.** via `steam://rungameid/<appId>` — no launcher of its own, no process supervision.

**accessibility.** fully keyboard operable, visible focus states, tabs following the WAI-ARIA pattern (arrow keys, roving tabindex), contrasts checked against WCAG AA, `prefers-reduced-motion` respected globally. font sizes in `rem` so the app scales with the system font size. interface in german and english, key parity guarded by a test.

### supported steam installations

protium auto-detects steam in these installation types:
- **native** — `~/.local/share/Steam` and `~/.steam/steam`
- **flatpak** — `~/.var/app/com.valvesoftware.Steam/.local/share/Steam`
- **symlinks and custom paths** — `discoverSteamRoot` resolves symlinks via `realpath`

snap support (`~/snap/steam/`) — included from 0.1.7, but only tested against fixtures, no real snap system verified yet.

### restoring a prefix from the trash

protium deliberately has **no** restore function: once a game is reinstalled, `compatdata/<appId>` exists again, and moving something back automatically would have to decide which state wins. on top of that, a prefix may originate from a different proton version than the one currently selected. those are decisions for a human, not for a tool.

by hand it is one `mv`. the trash lives in the same library, the entry is named `compatdata_<appId>_<timestamp>`:

```sh
cd /path/to/SteamLibrary/steamapps
ls .protium-trash                       # find the entry
mv .protium-trash/compatdata_1477940_1785071505657 compatdata/1477940
```

important: the target `compatdata/<appId>` must not already exist. if it does, you have two states — back up the existing one first, then decide. steam recreates a missing prefix on the next launch (without the old savegames, of course).

## why not an existing tool

The purpose is to make this information visible in one place. The first scan already revealed differences between the expected and the actually used proton configuration.

## stack

tauri v2 as the shell, vue 3 + typescript for UI and domain logic, rust only for what the webview is not allowed to do. no electron; the binary stays small and uses the system webview (webkit2gtk).

Concretely, rust only handles: under 1000 productive lines of rust — path validation, streaming downloads with hashing, tarball extraction, the two delete commands, process check, fs scope grants. Domain logic and UI decisions do not live in this layer. plus nearly twice as many lines of tests as production code. These paths modify or delete files and are therefore tested separately.

the domain logic in `src/core/` is entirely UI-free and talks to the system only through ports/adapters. that lets the whole core test suite run headless against fixtures — no tauri, no steam, no network.

## dev setup

prerequisites (cachyos/arch):

```sh
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl librsvg
rustup default stable   # if rust is missing: sudo pacman -S rustup
```

then:

```sh
npm install
npm test              # vitest — core headless against fixtures
npm run check         # biome (lint + format) + vue-tsc --noEmit
(cd src-tauri && cargo test)   # rust: download paths, path validation, tarball extraction, cleanup/trash
npm run tauri dev     # start the app (the first build compiles rust, takes a while)
```

`npm run check` and `npm test` also run in CI on every push and pull request. the tauri build does **not** — it needs system dependencies (webkit2gtk) and is a separate step.

the cache lives in `~/.cache/com.protium.desktop/`.


### dependencies and advisories

```sh
(cd src-tauri && cargo audit)
```

`src-tauri/audit.toml` lists advisories that are knowingly accepted — each by ID with a reason, so that a **new** advisory still trips the check. these mostly concern tauri's GTK3 stack (the gtk-rs bindings are unmaintained; gtk-rs moved on to GTK4) and build-time-only crates. to be revisited once tauri moves to gtk-rs 0.20.

## layout

```
src/core/       domain logic, UI-free. talks only through ports
src/core/adapters/tauri.ts   ports against plugin-fs/http + rust commands
src/ui/         vue app: library, proton manager, cleanup, i18n (de/en)
src-tauri/      rust commands (extract, download, process check, dir size, fs scope, delete paths)
tests/          vitest against fake-steam fixtures
docs/           screenshots, smoke checklist
```

The implementation follows these rules: writes to steam files go through a write gate without exception (steam-is-running check, backup, atomic write). destructive actions always ask and show concretely what would happen. where path knowledge is needed it comes from `paths.ts`, not from assembled strings. a network outage may impoverish features but must never block the app. If a value cannot be determined reliably, the app displays `unknown`.

## roadmap

- [x] phase 1: core data layer (scan, vdf parsing, protondb, multi-library incl. external mounts)
- [x] phase 2: library UI (cover grid, tiers, warnings, search/filter/sort)
- [x] phase 3: GE-proton manager (install/remove, queue, distro tool detection, cancellable downloads incl. cleanup)
- [x] game detail drawer with protondb link (other users' reports)
- [x] phase 4: setting compat tool and launch options (write gate, backups, vdf string patch)
- [x] phase 5: cleanup of orphaned prefixes and shader caches + trash
- [x] launching games (via the steam protocol, no launcher of its own)
- [x] i18n (german/english)
- [x] CI: lint, typecheck and tests on every push
- [x] phase 6 (part 1): AppImage build in CI (releases v0.1.x)
- [ ] phase 6 (part 2): AUR package

## status

under active development. api and UI change without notice. the roadmap describes the current state; it is not a promise of future versions.
