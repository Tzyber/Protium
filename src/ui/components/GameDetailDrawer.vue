<script setup lang="ts">
import { computed, ref } from "vue";
import { assetUrl, openExternal } from "../../core/adapters/tauri";
import { protonDbAppUrl } from "../../core/protondb";
import type { Tier } from "../../core/types";
import { formatBytes } from "../format";
import { useUiStore } from "../stores/uiStore";
import TierBadge from "./TierBadge.vue";

const ui = useUiStore();
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

async function openProtonDb() {
  if (game.value) await openExternal(protonDbAppUrl(game.value.appId)).catch(() => {});
}
</script>

<template>
  <transition name="drawer">
    <div v-if="game" class="wrap">
      <div class="scrim" @click="ui.closeGame()" />
      <aside class="drawer" role="dialog" aria-modal="true">
        <button class="close" type="button" aria-label="schließen" @click="ui.closeGame()">✕</button>

        <div class="cover">
          <img v-if="cover" :src="cover" :alt="game.name" @error="idx++" />
          <div v-else class="cover-fb"><span>{{ game.name }}</span></div>
        </div>

        <h2>{{ game.name }}</h2>

        <div class="rows">
          <div class="row"><span class="k">größe</span><span class="v mono">{{ formatBytes(game.sizeBytes) }}</span></div>
          <div class="row"><span class="k">proton</span><span class="v mono">{{ game.compatTool }}</span></div>
          <div class="row"><span class="k">app-id</span><span class="v mono">{{ game.appId }}</span></div>
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
  background: color-mix(in srgb, var(--signal) 14%, transparent);
  border: 1px solid var(--signal);
  color: var(--signal-bright);
  border-radius: var(--r-sm);
  padding: 11px 14px;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}
.pdb:hover { background: color-mix(in srgb, var(--signal) 22%, transparent); }
.hint { margin: 10px 2px 0; color: var(--fg-2); font-size: 10.5px; line-height: 1.5; }

.drawer-enter-active, .drawer-leave-active { transition: opacity 0.2s; }
.drawer-enter-active .drawer, .drawer-leave-active .drawer { transition: transform 0.2s ease; }
.drawer-enter-from, .drawer-leave-to { opacity: 0; }
.drawer-enter-from .drawer, .drawer-leave-to .drawer { transform: translateX(100%); }
</style>
