<script setup lang="ts">
import { computed, ref } from "vue";
import { assetUrl, launchGame } from "../../core/adapters/tauri";
import type { Game } from "../../core/types";
import { formatBytes } from "../format";
import { useUiStore } from "../stores/uiStore";
import TierBadge from "./TierBadge.vue";

const props = defineProps<{ game: Game }>();
const ui = useUiStore();

// kandidaten in reihenfolge: lokaler cache (CDN-unabhängig) → steam-cdn → text.
const candidates = computed<string[]>(() => {
  const list: string[] = [];
  if (props.game.localHeader) list.push(assetUrl(props.game.localHeader));
  if (props.game.headerImage) list.push(props.game.headerImage);
  return list;
});

const idx = ref(0);
const src = computed<string | null>(() => candidates.value[idx.value] ?? null);
function onError() {
  idx.value++; // nächster kandidat; ist keiner mehr da → text-fallback (INV-3)
}

function launch() {
  void launchGame(props.game.appId);
}
</script>

<template>
  <article class="card" role="button" tabindex="0" @click="ui.openGame(game)" @keydown.enter="ui.openGame(game)">
    <div class="cover">
      <img
        v-if="src"
        :src="src"
        :alt="game.name"
        loading="lazy"
        decoding="async"
        @error="onError"
      />
      <div v-else class="cover-fallback">
        <span class="fb-name">{{ game.name }}</span>
      </div>

      <div class="overlay-top">
        <TierBadge
          v-if="game.protonDb"
          :tier="game.protonDb.tier"
          :confidence="game.protonDb.confidence"
        />
      </div>
    </div>

    <div class="body">
      <h3 :title="game.name">{{ game.name }}</h3>
      <div class="meta">
        <span class="chip" :class="{ muted: game.compatTool === 'default' }" :title="game.compatTool">
          {{ game.compatTool }}
        </span>
        <div class="meta-right">
          <button
            class="play"
            type="button"
            :title="`${game.name} starten`"
            :aria-label="`${game.name} starten`"
            @click.stop="launch"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" /></svg>
          </button>
          <span class="size mono">{{ formatBytes(game.sizeBytes) }}</span>
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.card {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
}
.card:hover {
  border-color: var(--signal-dim);
  transform: translateY(-2px);
  box-shadow: 0 8px 24px -12px var(--signal-glow);
}

.cover {
  position: relative;
  aspect-ratio: 460 / 215;
  background: var(--bg-3);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cover-fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  padding: 12px;
  text-align: center;
  background:
    radial-gradient(120% 100% at 50% 0%, color-mix(in srgb, var(--signal) 10%, transparent), transparent 70%),
    linear-gradient(135deg, var(--bg-3), var(--bg-1));
}
.fb-name {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 15px;
  color: var(--fg-1);
  letter-spacing: -0.01em;
}

.overlay-top { position: absolute; top: 8px; right: 8px; }

.body { padding: 12px 12px 12px; }
h3 {
  margin: 0 0 10px;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.chip {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--signal-bright);
  background: color-mix(in srgb, var(--signal) 12%, transparent);
  border: 1px solid var(--signal-dim);
  padding: 4px 8px;
  border-radius: 999px;
  max-width: 62%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip.muted { color: var(--fg-2); background: transparent; border-color: var(--line); }
.size { color: var(--fg-2); font-size: 12px; white-space: nowrap; }

.meta-right { display: flex; align-items: center; gap: 8px; }
.play {
  display: grid;
  place-items: center;
  width: 45px;
  height: 30px;
  padding: 0;
  cursor: pointer;
  color: var(--signal-bright);
  background: color-mix(in srgb, var(--signal) 12%, transparent);
  border: 1px solid var(--signal-dim);
  border-radius: 10px;
  transition: background 0.15s, color 0.15s, transform 0.1s;
}
.play svg { width: 18px; height: 18px; fill: currentColor; margin-left: 1px; }
.play:hover { background: var(--signal); color: var(--bg-1); }
.play:active { transform: scale(0.92); }
.play:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
</style>
