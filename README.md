# protium

linux-desktop-app für steam/proton-housekeeping: library-übersicht, protondb-tiers,
GE-proton-versionsmanagement, per-game compat-tool/launch-options, cleanup.
tauri v2 + vue 3 + typescript. core headless-testbar (ports/adapter, INV-5).

status: phase 1–3 (data layer, library-UI, GE-proton-manager) implementiert.
debug-view. app scannt die echte library und dumpt das ScanResult als json.

## dev

voraussetzungen (cachyos/arch):
```
cargo --version   # rust nötig; falls nicht: sudo pacman -S rustup && rustup default stable
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl librsvg libappindicator-gtk3
```

```
npm install
npm test              # vitest — core headless, keine tauri/steam/netz nötig (19 tests)
npm run check         # biome
npm run tauri dev     # app-fenster; scannt echte library, json-dump (erster build dauert)
```

cache liegt unter `~/.cache/com.protium.desktop/cache/` (tauri app-cache, aus identifier).

## struktur
- `src/core/` — domänenlogik, UI-frei. `scanLibrary(ports)` ist die einzige public api.
- `src/core/adapters/tauri.ts` — ports gegen plugin-fs/http + rust-commands (einzige tauri-fläche im core).
- `src/ui/App.vue` — phase-1 debug-view (roher json-dump).
- `src-tauri/src/commands.rs` — R-2/R-3/R-5 + canonicalize implementiert; R-1/R-4 stubs (phase 3).
- `tests/` — vitest gegen fake-steam-fixtures. 
-
