<script setup lang="ts">
import { computed, nextTick, onMounted, watch } from "vue";
import ProtiumLogo from "./components/ProtiumLogo.vue";
import { t } from "./i18n";
import { useScanStore } from "./stores/scanStore";
import { useUiStore, type ViewId } from "./stores/uiStore";
import CleanupView from "./views/CleanupView.vue";
import LibraryView from "./views/LibraryView.vue";
import ProtonManagerView from "./views/ProtonManagerView.vue";

const scan = useScanStore();
const ui = useUiStore();
onMounted(() => scan.runScan());

// view-wechsel: h1 der neuen view fokussieren, damit screenreader den titel ansagen
watch(
  () => ui.activeView,
  async () => {
    await nextTick();
    const h1 = document.querySelector<HTMLElement>(".content h1");
    if (!h1) return;
    h1.tabIndex = -1;
    h1.focus({ preventScroll: true });
    h1.addEventListener(
      "blur",
      () => {
        h1.removeAttribute("tabindex");
      },
      { once: true },
    );
  },
);

const nav: { id: ViewId | "settings"; label: string; active: boolean }[] = [
  { id: "library", label: t("app.navLibrary"), active: true },
  { id: "proton", label: t("app.navProton"), active: true },
  { id: "cleanup", label: t("app.navCleanup"), active: true },
  { id: "settings", label: t("app.navSettings"), active: false },
];

const rootShort = computed(() => {
  const r = scan.result?.steamRoot;
  return r ? r.replace(/^\/home\/[^/]+/, "~") : "—";
});
</script>

<template>
  <a class="skip-link" href="#main-content">{{ t("app.skipToContent") }}</a>
  <div class="shell">
    <aside class="sidebar" :inert="ui.inertMain || undefined">
      <div class="brand">
        <div class="logo"><ProtiumLogo :size="28"/></div>
        <div>
          <div class="name">PROTIUM</div>
          <div class="label">{{ t("app.brandTagline") }}</div>
        </div>
      </div>

      <nav :aria-label="t('app.navAria')">
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
          <span v-if="!item.active" class="soon">{{ t("app.phaseUpcoming") }}</span>
        </button>
      </nav>

      <div class="readout">
        <div class="row"><span class="label">{{ t("app.root") }}</span><span class="mono val">{{ rootShort }}</span></div>
        <div class="row"><span class="label">{{ t("app.libs") }}</span><span class="mono val">{{ scan.result?.libraries.length ?? "—" }}</span></div>
        <div class="row"><span class="label">{{ t("app.tools") }}</span><span class="mono val">{{ scan.compatTools.length || "—" }}</span></div>
        <div class="row" v-if="scan.elapsedMs"><span class="label">{{ t("app.scan") }}</span><span class="mono val">{{ scan.elapsedMs }} ms</span></div>
      </div>
    </aside>

    <main id="main-content" class="content">
      <LibraryView v-if="ui.activeView === 'library'" />
      <ProtonManagerView v-else-if="ui.activeView === 'proton'" />
      <CleanupView v-else-if="ui.activeView === 'cleanup'" />
    </main>
  </div>
</template>

<style scoped>
.skip-link {
  position: absolute;
  top: -100%;
  left: 8px;
  z-index: 100;
  background: var(--signal);
  color: var(--bg-0);
  padding: 8px 14px;
  border-radius: var(--r-sm);
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 0.875rem;
  text-decoration: none;
}
.skip-link:focus-visible {
  top: 8px;
}

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
  font-size: 0.9375rem;
  box-shadow: 0 0 18px -4px var(--signal-glow);
}
.brand .name { font-family: var(--font-display); font-weight: 700; letter-spacing: 0.06em; font-size: 0.9375rem; }

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
  font-family: var(--font-body);
  font-size: 0.875rem;
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
.soon { font-family: var(--font-mono); font-size: 0.75rem; letter-spacing: 0.1em; opacity: 0.85; }

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
.readout .val { color: var(--fg-1); font-size: 0.8125rem; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.content {
  min-height: 0;
  overflow-y: scroll;
  overflow-x: auto;
  scrollbar-gutter: stable;
}
</style>
