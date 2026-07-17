<script setup lang="ts">
import { computed, ref } from "vue";
import FilterBar from "../components/FilterBar.vue";
import GameCard from "../components/GameCard.vue";
import GameDetailDrawer from "../components/GameDetailDrawer.vue";
import { filterAndSortGames } from "../filter";
import { useLibraryStore } from "../stores/libraryStore";
import { useScanStore } from "../stores/scanStore";

const scan = useScanStore();
const lib = useLibraryStore();

const visible = computed(() =>
  filterAndSortGames(scan.games, {
    search: lib.search,
    sortKey: lib.sortKey,
    sortDir: lib.sortDir,
    tiers: lib.tierSet,
    compatTools: lib.compatToolSet,
    libraries: lib.librarySet,
  }),
);

const showWarnings = ref(false);
</script>

<template>
  <section class="library">
    <header class="bar">
      <div class="title">
        <span class="label">library</span>
        <h2>
          {{ visible.length }}
          <span class="unit">/ {{ scan.games.length }} spiele</span>
        </h2>
      </div>

      <div class="right">
        <button
          v-if="scan.warnings.length"
          class="warn-toggle"
          type="button"
          @click="showWarnings = !showWarnings"
        >
          ⚠ {{ scan.warnings.length }}
        </button>
        <span class="status mono">{{ scan.statusText }}</span>
        <button class="rescan" type="button" :disabled="scan.status === 'scanning'" @click="scan.runScan()">
          {{ scan.status === "scanning" ? "scannt…" : "neu scannen" }}
        </button>
      </div>
    </header>

    <transition name="fade">
      <ul v-if="showWarnings && scan.warnings.length" class="warnings">
        <li v-for="(w, i) in scan.warnings" :key="i">{{ w }}</li>
      </ul>
    </transition>

    <FilterBar v-if="scan.games.length" />

    <div v-if="scan.status === 'not-found'" class="empty">
      keine steam-installation an den bekannten pfaden gefunden.
    </div>
    <div v-else-if="scan.status === 'error'" class="empty err">fehler: {{ scan.error }}</div>
    <div v-else-if="scan.status === 'scanning' && !scan.games.length" class="empty">scanne…</div>
    <div v-else-if="!visible.length" class="empty">
      nichts gefunden — <button class="linklike" type="button" @click="lib.reset()">filter zurücksetzen</button>
    </div>

    <div v-else class="grid">
      <GameCard v-for="g in visible" :key="g.appId" :game="g" />
    </div>

    <GameDetailDrawer />
  </section>
</template>

<style scoped>
.library { padding: 20px 24px; }

.bar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}
.title h2 {
  margin: 2px 0 0;
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.title .unit { color: var(--fg-2); font-size: 15px; font-weight: 400; }

.right { display: flex; align-items: center; gap: 12px; }
.status { color: var(--fg-2); font-size: 11px; }

.rescan {
  background: var(--signal);
  color: #0a0b11;
  border: none;
  border-radius: var(--r-sm);
  padding: 8px 14px;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s;
}
.rescan:hover:not(:disabled) { background: var(--signal-bright); box-shadow: 0 0 20px -4px var(--signal-glow); }
.rescan:disabled { opacity: 0.5; cursor: default; }

.warn-toggle {
  background: color-mix(in srgb, var(--tier-gold) 12%, transparent);
  color: var(--tier-gold);
  border: 1px solid color-mix(in srgb, var(--tier-gold) 40%, transparent);
  border-radius: var(--r-sm);
  padding: 6px 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
}

.warnings {
  margin: 0 0 18px;
  padding: 12px 14px;
  list-style: none;
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-left: 2px solid var(--tier-gold);
  border-radius: var(--r-sm);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--fg-1);
  display: grid;
  gap: 6px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--gap);
}

.empty {
  padding: 60px 0;
  text-align: center;
  color: var(--fg-2);
  font-family: var(--font-mono);
}
.empty.err { color: var(--tier-borked); }
.linklike { background: none; border: none; color: var(--signal-bright); cursor: pointer; font: inherit; text-decoration: underline; }

.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
