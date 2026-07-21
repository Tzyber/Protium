<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { assetUrl, launchGame, openExternal } from "../../core/adapters/tauri";
import { protonDbAppUrl } from "../../core/protondb";
import type { Tier } from "../../core/types";
import { focusFirstFocusable, restoreFocus, trapFocus } from "../a11y";
import { formatBytes } from "../format";
import { useConfigStore } from "../stores/configStore";
import { useScanStore } from "../stores/scanStore";
import { useUiStore } from "../stores/uiStore";
import TierBadge from "./TierBadge.vue";

const ui = useUiStore();
const config = useConfigStore();
const scan = useScanStore();
const game = computed(() => ui.selectedGame);

const TIER_LABEL: Record<Tier, string> = {
  platinum: "läuft perfekt, out of the box",
  gold: "läuft perfekt nach kleinen tweaks",
  silver: "läuft mit einschränkungen",
  bronze: "läuft, aber mit problemen",
  borked: "läuft aktuell nicht",
  unknown: "keine protondb-daten",
};

// cover-kandidaten wie in der karte
const idx = ref(0);
const cover = computed<string | null>(() => {
  const g = game.value;
  if (!g) return null;
  const list: string[] = [];
  if (g.localHeader) list.push(assetUrl(g.localHeader));
  if (g.headerImage) list.push(g.headerImage);
  return list[idx.value] ?? null;
});

const drawerRef = ref<HTMLElement | null>(null);
const titleId = "game-detail-title";
const descriptionId = "game-detail-description";
let lastFocusedElement: HTMLElement | null = null;

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.stopPropagation();
    ui.closeGame();
    return;
  }

  trapFocus(event, drawerRef.value);
}

watch(
  game,
  async (current) => {
    if (current) {
      lastFocusedElement =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      await nextTick();
      focusFirstFocusable(drawerRef.value);
      return;
    }

    await nextTick();
    restoreFocus(lastFocusedElement);
    lastFocusedElement = null;
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer);
  restoreFocus(lastFocusedElement);
});

async function openProtonDb() {
  if (game.value) await openExternal(protonDbAppUrl(game.value.appId)).catch(() => {});
}

function launch() {
  const currentGame = game.value;
  if (!currentGame) return;
  void launchGame(currentGame.appId).catch(() => {});
}

// startoptionen (phase 4): "idle" | "saving" | "saved" | fehlermeldung
const launchInput = ref("");
const launchState = ref<"idle" | "saving" | "saved" | string>("idle");
const launchDirty = computed(() => launchInput.value !== (game.value?.launchOptions ?? ""));

watch(
  game,
  (g) => {
    launchInput.value = g?.launchOptions ?? "";
    launchState.value = "idle";
  },
  { immediate: true },
);
watch(launchInput, () => {
  if (launchState.value === "saved") launchState.value = "idle";
});

async function saveLaunch() {
  const g = game.value;
  if (!g || launchState.value === "saving" || !launchDirty.value) return;
  launchState.value = "saving";
  try {
    await config.saveLaunchOptions(g.appId, launchInput.value.trim());
    launchState.value = "saved";
  } catch (e) {
    launchState.value = (e as Error).message;
  }
}

// compat-tool-dropdown (phase 4, schritt 5)
const compatSelected = ref("__default__");
const compatState = ref<"idle" | "saving" | "saved" | string>("idle");

const compatOptions = computed(() => {
  const tools = scan.result?.compatToolsInstalled ?? [];
  const current = game.value?.compatTool ?? "";
  const list: { value: string; label: string }[] = [];

  for (const t of tools) {
    list.push({ value: t.internalName, label: t.displayName });
  }

  if (current && current !== "default" && !tools.some((t) => t.internalName === current)) {
    list.push({ value: current, label: `${current} (nicht installiert)` });
  }

  return list;
});

const compatDirty = computed(() => {
  const current = game.value?.compatTool ?? "default";
  const expected = current === "default" ? "__default__" : current;
  return compatSelected.value !== expected;
});

watch(
  game,
  (g) => {
    const tool = g?.compatTool;
    compatSelected.value = tool && tool !== "default" ? tool : "__default__";
    compatState.value = "idle";
  },
  { immediate: true },
);

watch(compatSelected, () => {
  if (compatState.value === "saved") compatState.value = "idle";
});

async function saveCompat() {
  const g = game.value;
  if (!g || compatState.value === "saving" || !compatDirty.value) return;
  compatState.value = "saving";
  try {
    const name = compatSelected.value === "__default__" ? null : compatSelected.value;
    await config.saveCompatTool(g.appId, name);
    compatState.value = "saved";
  } catch (e) {
    compatState.value = (e as Error).message;
  }
}

// fehler-toast: der state ist entweder ein bekanntes schlagwort oder die fehlermeldung.
function stateError(s: string): string | null {
  return s === "idle" || s === "saving" || s === "saved" ? null : s;
}
const errorMessage = computed(() => stateError(compatState.value) ?? stateError(launchState.value));
function dismissError() {
  if (stateError(compatState.value)) compatState.value = "idle";
  if (stateError(launchState.value)) launchState.value = "idle";
}

// toast nach 6s automatisch schließen (bleibt bei erneutem fehler frisch stehen).
let toastTimer: ReturnType<typeof setTimeout> | null = null;
watch(errorMessage, (msg) => {
  if (toastTimer) clearTimeout(toastTimer);
  if (msg) toastTimer = setTimeout(dismissError, 6000);
});
</script>

<template>
  <transition name="drawer">
    <div v-if="game" class="wrap">
      <div class="scrim" @click="ui.closeGame()" />
      <aside
        ref="drawerRef"
        class="drawer"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="descriptionId"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <button class="close" type="button" aria-label="schließen" @click="ui.closeGame()">✕</button>

        <p :id="descriptionId" class="sr-only">
          details zu {{ game.name }}. größe {{ formatBytes(game.sizeBytes) }}, proton {{ game.compatTool }}, app-id
          {{ game.appId }}.
        </p>

        <div class="cover">
          <img v-if="cover" :src="cover" :alt="game.name" @error="idx++" />
          <div v-else class="cover-fb"><span>{{ game.name }}</span></div>
        </div>

        <div class="head">
          <h2 :id="titleId">{{ game.name }}</h2>
          <TierBadge
            v-if="game.protonDb"
            :tier="game.protonDb.tier"
            :confidence="game.protonDb.confidence"
          />
        </div>
        <p class="meta mono">{{ formatBytes(game.sizeBytes) }} · app {{ game.appId }}</p>
        <p class="meta-tier">{{ TIER_LABEL[game.protonDb?.tier ?? "unknown"] }}</p>

        <button
          class="play"
          type="button"
          :title="`${game.name} starten`"
          :aria-label="`${game.name} starten`"
          @click.stop="launch"
        >
          spiel starten
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" /></svg>
        </button>

        <div class="divider" />
        <p class="section-label mono">konfiguration</p>

        <div class="field">
          <label class="k" for="compat-tool">proton / compat-tool</label>
          <div class="field-row">
            <select id="compat-tool" v-model="compatSelected" class="control mono">
              <option value="__default__">standard (system-default)</option>
              <option v-for="o in compatOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <button
              class="save"
              type="button"
              :disabled="!compatDirty || compatState === 'saving'"
              @click="saveCompat"
            >
              {{ compatState === "saving" ? "…" : compatState === "saved" ? "gespeichert ✓" : "speichern" }}
            </button>
          </div>
        </div>

        <div class="field">
          <label class="k" for="launch-options">startoptionen</label>
          <div class="field-row">
            <input
              id="launch-options"
              v-model="launchInput"
              type="text"
              class="control mono"
              placeholder="z. b. gamemoderun %command% -novid"
              spellcheck="false"
              @keydown.enter="saveLaunch"
            />
            <button
              class="save"
              type="button"
              :disabled="!launchDirty || launchState === 'saving'"
              @click="saveLaunch"
            >
              {{ launchState === "saving" ? "…" : launchState === "saved" ? "gespeichert ✓" : "speichern" }}
            </button>
          </div>
          <p class="hint">
            %command% = der eigentliche startbefehl; weglassen hängt die optionen nur an.
          </p>
        </div>

        <div class="divider" />

        <a class="pdb-link mono" href="#" @click.prevent="openProtonDb">
          auf protondb ansehen ↗
        </a>
        <p class="hint">
          reports mit betriebssystem, proton-version und notizen anderer spieler. daten von protondb (ODbL).
        </p>

        <!-- fehler-toast: oben fixiert im drawer, direkt im blick der eingaben -->
        <transition name="toast">
          <div v-if="errorMessage" class="toast" role="alert">
            <span class="toast-icon" aria-hidden="true">⚠</span>
            <span class="toast-msg">{{ errorMessage }}</span>
            <button class="toast-close" type="button" aria-label="meldung schließen" @click="dismissError">✕</button>
          </div>
        </transition>
      </aside>
    </div>
  </transition>
</template>

<style scoped>
.wrap { position: fixed; inset: 0; z-index: 40; }
.scrim { position: absolute; inset: 0; background: rgba(4, 5, 9, 0.55); }
.drawer {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  width: min(420px, 92vw);
  background: var(--bg-1);
  border-left: 1px solid var(--line);
  box-shadow: -24px 0 60px -20px rgba(0, 0, 0, 0.6);
  padding: 20px 22px;
  overflow-y: auto;
}

.close {
  position: absolute; top: 14px; right: 16px;
  background: none; border: none; color: var(--fg-2);
  font-size: 15px; cursor: pointer; z-index: 2;
}
.close:hover { color: var(--fg-0); }

.cover {
  aspect-ratio: 460 / 215;
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--bg-3);
  margin-bottom: 14px;
}
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cover-fb {
  width: 100%; height: 100%; display: grid; place-items: center; padding: 12px; text-align: center;
  background: linear-gradient(135deg, var(--bg-3), var(--bg-1));
  font-family: var(--font-display); font-weight: 600; color: var(--fg-1);
}

.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.head h2 { margin: 0; font-family: var(--font-display); font-size: 21px; font-weight: 600; letter-spacing: -0.02em; }
.head :deep(*) { flex-shrink: 0; }
.meta { margin: 6px 0 2px; color: var(--fg-2); font-size: 13px; }
.meta-tier { margin: 0 0 20px; color: var(--fg-1); font-size: 13px; line-height: 1.5; }

.play {
  width: 100%;
  background: var(--signal);
  border: 1px solid var(--signal);
  color: var(--bg-0);
  border-radius: var(--r-sm);
  padding: 13px 14px;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 15px;
  cursor: pointer;
  transition: filter 0.15s, transform 0.1s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.play svg { width: 15px; height: 15px; fill: currentColor; }
.play:hover { filter: brightness(1.12); }
.play:active { transform: scale(0.98); }
.play:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }

.divider { height: 1px; background: var(--line-soft); margin: 20px 0 16px; }
.section-label {
  margin: 0 0 14px;
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--fg-1);
  text-transform: uppercase;
}

.field { margin-bottom: 16px; }
.k { display: block; color: var(--fg-1); font-size: 13px; margin-bottom: 7px; }
.field-row { display: flex; gap: 8px; }
.control {
  flex: 1;
  min-width: 0;
  background: var(--bg-2);
  border: 1px solid var(--line);
  color: var(--fg-0);
  border-radius: var(--r-sm);
  padding: 11px 13px;
  font-size: 13px;
}
.control:focus { outline: none; border-color: var(--signal-dim); }
select.control { cursor: pointer; }
select.control option { background: var(--bg-1); color: var(--fg-0); }

.save {
  flex-shrink: 0;
  background: var(--bg-2);
  border: 1px solid var(--signal-dim);
  color: var(--signal-bright);
  border-radius: var(--r-sm);
  padding: 11px 15px;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, border-color 0.15s;
}
.save:hover:not(:disabled) { background: var(--bg-3); border-color: var(--signal); }
.save:disabled { opacity: 0.4; cursor: default; }

.hint { margin: 9px 2px 0; color: var(--fg-2); font-size: 12.5px; line-height: 1.55; }

.pdb-link {
  display: inline-block;
  color: var(--signal-bright);
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  transition: color 0.15s;
}
.pdb-link:hover { color: var(--signal); text-decoration: underline; }

.toast {
  position: sticky;
  top: 8px;
  z-index: 3;
  margin: 12px 0 0;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  background: var(--bg-2);
  border: 1px solid var(--tier-borked);
  border-left: 3px solid var(--tier-borked);
  border-radius: var(--r-sm);
  padding: 11px 13px;
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.6);
}
.toast-icon { color: var(--tier-borked); font-size: 14px; flex-shrink: 0; margin-top: 1px; }
.toast-msg { flex: 1; color: var(--fg-0); font-size: 13.5px; line-height: 1.5; }
.toast-close {
  flex-shrink: 0; background: none; border: none; color: var(--fg-2);
  font-size: 12px; cursor: pointer; padding: 0; line-height: 1;
}
.toast-close:hover { color: var(--fg-0); }
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(-6px); }

.drawer-enter-active .drawer, .drawer-leave-active .drawer { transition: transform 0.2s ease; }
.drawer-enter-from .drawer, .drawer-leave-to .drawer { transform: translateX(100%); }
</style>
