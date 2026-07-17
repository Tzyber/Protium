<script setup lang="ts">
import { computed } from "vue";
import type { Tier } from "../../core/types";
import type { SortKey } from "../filter";
import { useLibraryStore } from "../stores/libraryStore";
import { useScanStore } from "../stores/scanStore";

const scan = useScanStore();
const lib = useLibraryStore();

const TIER_ORDER: Tier[] = ["platinum", "gold", "silver", "bronze", "borked", "unknown"];
const SORTS: { key: SortKey; label: string }[] = [
  { key: "name", label: "name" },
  { key: "size", label: "größe" },
  { key: "tier", label: "tier" },
];

// nur tatsächlich vorkommende werte als filteroptionen anbieten
const tiersPresent = computed(() => {
  const set = new Set(scan.games.map((g) => g.protonDb?.tier ?? "unknown"));
  return TIER_ORDER.filter((t) => set.has(t));
});
const compatToolsPresent = computed(() => [...new Set(scan.games.map((g) => g.compatTool))].sort());
const librariesPresent = computed(() => [...new Set(scan.games.map((g) => g.library))]);

const arrow = computed(() => (lib.sortDir === "asc" ? "↑" : "↓"));

function libShort(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
</script>

<template>
  <div class="filterbar">
    <div class="search">
      <span class="ico">⌕</span>
      <input v-model="lib.search" type="text" placeholder="suchen…" spellcheck="false" />
      <button v-if="lib.search" class="clear" type="button" @click="lib.search = ''">✕</button>
    </div>

    <div class="group">
      <span class="label">sort</span>
      <button
        v-for="s in SORTS"
        :key="s.key"
        class="seg"
        :class="{ on: lib.sortKey === s.key }"
        type="button"
        @click="lib.setSort(s.key)"
      >
        {{ s.label }}<span v-if="lib.sortKey === s.key" class="arr">{{ arrow }}</span>
      </button>
    </div>

    <div class="group">
      <button
        v-for="t in tiersPresent"
        :key="t"
        class="tier-pill"
        :class="[`t-${t}`, { on: lib.tiers.includes(t) }]"
        type="button"
        @click="lib.toggle('tiers', t)"
      >
        {{ t }}
      </button>
    </div>

    <div v-if="compatToolsPresent.length > 1" class="group">
      <span class="label">proton</span>
      <button
        v-for="c in compatToolsPresent"
        :key="c"
        class="seg small"
        :class="{ on: lib.compatTools.includes(c) }"
        type="button"
        :title="c"
        @click="lib.toggle('compatTools', c)"
      >
        {{ c }}
      </button>
    </div>

    <div v-if="librariesPresent.length > 1" class="group">
      <span class="label">disk</span>
      <button
        v-for="l in librariesPresent"
        :key="l"
        class="seg small"
        :class="{ on: lib.libraries.includes(l) }"
        type="button"
        :title="l"
        @click="lib.toggle('libraries', l)"
      >
        {{ libShort(l) }}
      </button>
    </div>

    <button v-if="lib.activeFilterCount || lib.search" class="reset" type="button" @click="lib.reset()">
      zurücksetzen
    </button>
  </div>
</template>

<style scoped>
.filterbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  padding: 12px 14px;
  margin-bottom: 18px;
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}

.search {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-0);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  padding: 0 8px;
  flex: 1 1 200px;
  min-width: 160px;
}
.search:focus-within { border-color: var(--signal-dim); }
.search .ico { color: var(--fg-2); font-size: 15px; }
.search input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--fg-0);
  font-family: var(--font-body);
  font-size: 13px;
  padding: 8px 0;
}
.search .clear { background: none; border: none; color: var(--fg-2); cursor: pointer; font-size: 11px; }

.group { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }

.seg {
  background: var(--bg-2);
  border: 1px solid var(--line);
  color: var(--fg-1);
  border-radius: var(--r-sm);
  padding: 6px 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}
.seg.small { font-size: 10px; padding: 5px 8px; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seg:hover { color: var(--fg-0); border-color: var(--signal-dim); }
.seg.on {
  color: var(--signal-bright);
  border-color: var(--signal);
  background: color-mix(in srgb, var(--signal) 14%, transparent);
}
.arr { margin-left: 5px; opacity: 0.8; }

.tier-pill {
  --c: var(--tier-unknown);
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--c) 45%, transparent);
  color: color-mix(in srgb, var(--c) 75%, var(--fg-1));
  border-radius: 999px;
  padding: 5px 10px;
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  cursor: pointer;
}
.tier-pill.on { background: color-mix(in srgb, var(--c) 20%, transparent); color: var(--c); border-color: var(--c); }
.t-platinum { --c: var(--tier-platinum); }
.t-gold { --c: var(--tier-gold); }
.t-silver { --c: var(--tier-silver); }
.t-bronze { --c: var(--tier-bronze); }
.t-borked { --c: var(--tier-borked); }
.t-unknown { --c: var(--tier-unknown); }

.reset {
  margin-left: auto;
  background: none;
  border: 1px solid var(--line);
  color: var(--fg-2);
  border-radius: var(--r-sm);
  padding: 6px 10px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  cursor: pointer;
}
.reset:hover { color: var(--fg-0); border-color: var(--signal-dim); }
</style>
