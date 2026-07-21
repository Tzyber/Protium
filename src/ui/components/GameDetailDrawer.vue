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

        <h2 :id="titleId">{{ game.name }}</h2>

        <div class="rows">
          <div class="row"><span class="k">größe</span><span class="v mono">{{ formatBytes(game.sizeBytes) }}</span></div>
          <div class="row">
            <span class="k">app-id</span><span class="v mono">{{ game.appId }}</span></div>
        </div>

        <div class="compat-block">
          <label class="k" for="compat-tool">proton / compat-tool</label>
          <div class="compat-row">
            <select
              id="compat-tool"
              v-model="compatSelected"
              class="compat-select mono"
            >
              <option value="__default__">standard (system-default)</option>
              <option
                v-for="o in compatOptions"
                :key="o.value"
                :value="o.value"
              >{{ o.label }}</option>
            </select>
            <button
              class="save"
              type="button"
              :disabled="!compatDirty || compatState === 'saving'"
              @click="saveCompat"
            >
              {{ compatState === "saving" ? "…" : "speichern" }}
            </button>
          </div>
          <p v-if="compatState === 'saved'" class="launch-note ok">gespeichert ✓</p>
          <p v-else-if="compatState !== 'idle' && compatState !== 'saving'" class="launch-note err">
            {{ compatState }}
          </p>
        </div>

        <div class="launch-block">
          <label class="k" for="launch-options">startoptionen</label>
          <div class="launch-row">
            <input
              id="launch-options"
              v-model="launchInput"
              type="text"
              class="launch-input mono"
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
              {{ launchState === "saving" ? "…" : "speichern" }}
            </button>
          </div>
          <p v-if="launchState === 'saved'" class="launch-note ok">gespeichert ✓</p>
          <p v-else-if="launchState !== 'idle' && launchState !== 'saving'" class="launch-note err">
            {{ launchState }}
          </p>
          <p v-else class="hint">
            %command% = der eigentliche startbefehl; lässt man es weg, hängt steam die optionen nur an.
          </p>
        </div>

        <div class="tier-block">
          <div class="tier-head">
            <span class="k">protondb</span>
            <TierBadge
              v-if="game.protonDb"
              :tier="game.protonDb.tier"
              :confidence="game.protonDb.confidence"
            />
          </div>
          <p class="tier-desc">{{ TIER_LABEL[game.protonDb?.tier ?? "unknown"] }}</p>
          <p v-if="game.protonDb" class="conf mono">konfidenz: {{ game.protonDb.confidence }}</p>
        </div>
        <button class="play"
            type="button"
            :title="`${game.name} starten`"
            :aria-label="`${game.name} starten`"
            @click.stop="launch">
          spiel starten
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" /></svg>
        </button>
        <button class="pdb" type="button" @click="openProtonDb">
          auf protondb ansehen — berichte anderer nutzer ↗
        </button>
        <p class="hint">
          zeigt reports mit betriebssystem, proton-version und notizen anderer spieler.
          daten von protondb (ODbL).
        </p>
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
  font-size: 15px; cursor: pointer;
}
.close:hover { color: var(--fg-0); }



.cover {
  aspect-ratio: 460 / 215;
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--bg-3);
  margin-bottom: 16px;
}
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cover-fb {
  width: 100%; height: 100%; display: grid; place-items: center; padding: 12px; text-align: center;
  background: linear-gradient(135deg, var(--bg-3), var(--bg-1));
  font-family: var(--font-display); font-weight: 600; color: var(--fg-1);
}

h2 { margin: 0 0 16px; font-family: var(--font-display); font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }

.rows { display: grid; gap: 8px; margin-bottom: 18px; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--line-soft); }
.k { color: var(--fg-2); font-size: 12px; }
.v { color: var(--fg-0); font-size: 12px; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.launch-block { margin-bottom: 18px; }
.launch-row { display: flex; gap: 8px; margin-top: 6px; }
.launch-input {
  flex: 1;
  min-width: 0;
  background: var(--bg-2);
  border: 1px solid var(--line);
  color: var(--fg-0);
  border-radius: var(--r-sm);
  padding: 9px 12px;
  font-size: 12px;
}
.launch-input:focus { outline: none; border-color: var(--signal-dim); }
.save {
  background: var(--signal);
  border: 1px solid var(--signal);
  color: var(--bg-1);
  border-radius: var(--r-sm);
  padding: 9px 14px;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  transition: filter 0.15s;
}
.save:hover:not(:disabled) { filter: brightness(1.12); }
.save:disabled { opacity: 0.45; cursor: default; }
.launch-note { margin: 8px 2px 0; font-size: 12px; }
.launch-note.ok { color: var(--signal); }
.launch-note.err { color: var(--tier-borked); }

.compat-block { margin-bottom: 18px; }
.compat-row { display: flex; gap: 8px; margin-top: 6px; }
.compat-select {
  flex: 1;
  min-width: 0;
  background: var(--bg-2);
  border: 1px solid var(--line);
  color: var(--fg-0);
  border-radius: var(--r-sm);
  padding: 9px 10px;
  font-size: 12px;
  cursor: pointer;
}
.compat-select:focus { outline: none; border-color: var(--signal-dim); }
.compat-select option { background: var(--bg-1); color: var(--fg-0); }

.tier-block {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 14px;
  margin-bottom: 18px;
}
.tier-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.tier-desc { margin: 0; color: var(--fg-1); font-size: 13px; }
.conf { margin: 6px 0 0; color: var(--fg-2); font-size: 10.5px; }

.pdb {
  width: 100%;
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-1);
  border-radius: var(--r-sm);
  padding: 11px 14px;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.play {
  width: 100%;
  background: var(--signal);
  border: 1px solid var(--signal);
  color: var(--bg-1);
  border-radius: var(--r-sm);
  padding: 12px 14px;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 16px;
  cursor: pointer;
  transition: filter 0.15s, transform 0.1s;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.play svg { width: 16px; height: 16px; fill: currentColor; }
.play:hover { filter: brightness(1.12); }
.play:active { transform: scale(0.98); }
.play:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }

.pdb:hover { background: var(--bg-2); border-color: var(--signal-dim); }
.hint { margin: 10px 2px 0; color: var(--fg-2); font-size: 12px; line-height: 1.5; }

.drawer-enter-active .drawer, .drawer-leave-active .drawer { transition: transform 0.2s ease; }
.drawer-enter-from .drawer, .drawer-leave-to .drawer { transform: translateX(100%); }
</style>
