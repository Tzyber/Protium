<script setup lang="ts">
import { computed, onMounted } from "vue";
import ProtiumLogo from "./components/ProtiumLogo.vue";
import { useScanStore } from "./stores/scanStore";
import { useUiStore, type ViewId } from "./stores/uiStore";
import CleanupView from "./views/CleanupView.vue";
import LibraryView from "./views/LibraryView.vue";
import ProtonManagerView from "./views/ProtonManagerView.vue";

const scan = useScanStore();
const ui = useUiStore();
onMounted(() => scan.runScan());

const nav: { id: ViewId | "settings"; label: string; active: boolean }[] = [
  { id: "library", label: "Library", active: true },
  { id: "proton", label: "Proton", active: true },
  { id: "cleanup", label: "Cleanup", active: true },
  { id: "settings", label: "Settings", active: false },
];

const rootShort = computed(() => {
  const r = scan.result?.steamRoot;
  return r ? r.replace(/^\/home\/[^/]+/, "~") : "—";
});
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="logo"><ProtiumLogo :size="28"/></div>
        <div>
          <div class="name">PROTIUM</div>
          <div class="label">steam · proton</div>
        </div>
      </div>

      <nav aria-label="Hauptnavigation">
        <button
          v-for="item in nav"
          :key="item.id"
          class="nav-item"
          :class="{ active: item.active && ui.activeView === item.id }"
          :disabled="!item.active"
          type="button"
          :aria-current="item.active && ui.activeView === item.id ? 'page' : undefined"
          @click="item.active && ui.go(item.id as ViewId)"
        >
          {{ item.label }}
          <span v-if="!item.active" class="soon">phase 5+</span>
        </button>
      </nav>

      <div class="readout">
        <div class="row"><span class="label">root</span><span class="mono val">{{ rootShort }}</span></div>
        <div class="row"><span class="label">libs</span><span class="mono val">{{ scan.result?.libraries.length ?? "—" }}</span></div>
        <div class="row"><span class="label">tools</span><span class="mono val">{{ scan.compatTools.length || "—" }}</span></div>
        <div class="row" v-if="scan.elapsedMs"><span class="label">scan</span><span class="mono val">{{ scan.elapsedMs }} ms</span></div>
      </div>
    </aside>

    <main class="content">
      <LibraryView v-if="ui.activeView === 'library'" />
      <ProtonManagerView v-else-if="ui.activeView === 'proton'" />
      <CleanupView v-else-if="ui.activeView === 'cleanup'" />
    </main>
  </div>
</template>

<style scoped>
.shell { display: grid; grid-template-columns: 216px 1fr; height: 100%; }

.sidebar {
  background: var(--bg-1);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  padding: 18px 14px;
  gap: 24px;
}

.brand { display: flex; align-items: center; gap: 10px; }
.logo {
  width: 32px; height: 32px;
  display: grid; place-items: center;
  background: var(--signal);
  color: var(--bg-0);
  border-radius: 8px;
  font-size: 15px;
  box-shadow: 0 0 18px -4px var(--signal-glow);
}
.brand .name { font-family: var(--font-display); font-weight: 700; letter-spacing: 0.06em; font-size: 15px; }

nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  padding: 9px 12px;
  color: var(--fg-1);
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}
.nav-item:hover:not(:disabled):not(.active) { background: var(--bg-2); color: var(--fg-0); }
.nav-item.active {
  background: color-mix(in srgb, var(--signal) 14%, transparent);
  color: var(--signal-bright);
  box-shadow: inset 2px 0 0 var(--signal);
}
.nav-item:disabled { color: var(--fg-2); cursor: default; }
.soon { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; opacity: 0.6; }

.readout {
  margin-top: auto;
  display: grid;
  gap: 7px;
  padding: 12px;
  background: var(--bg-0);
  border: 1px solid var(--line-soft);
  border-radius: var(--r-sm);
}
.readout .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.readout .val { color: var(--fg-1); font-size: 11px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.content {
  overflow-y: scroll;
  overflow-x: auto;
  scrollbar-gutter: stable;
}
</style>
