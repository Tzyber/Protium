<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import type { OrphanEntry } from "../../core/types";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { formatBytes } from "../format";
import { useCleanupStore } from "../stores/cleanupStore";

const cleanup = useCleanupStore();

onMounted(() => cleanup.scanOrphans());

const bySize = (a: OrphanEntry, b: OrphanEntry) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
const shadercacheOrphans = computed(() => [...cleanup.shadercacheOrphans].sort(bySize));
const compatdataOrphans = computed(() => [...cleanup.compatdataOrphans].sort(bySize));

const selected = reactive(new Set<string>());

function toggle(key: string) {
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
}

const shadercacheTotalBytes = computed(() =>
  shadercacheOrphans.value.reduce((sum, o) => sum + (o.sizeBytes ?? 0), 0),
);
const compatdataTotalBytes = computed(() =>
  compatdataOrphans.value.reduce((sum, o) => sum + (o.sizeBytes ?? 0), 0),
);

function selectAllShader() {
  const all = shadercacheOrphans.value.every((o) => selected.has(cleanup.key(o)));
  for (const o of shadercacheOrphans.value) {
    if (all) selected.delete(cleanup.key(o));
    else selected.add(cleanup.key(o));
  }
}

function selectAllCompat() {
  const candidates = compatdataOrphans.value.filter((o) => !o.potentialShortcut);
  const all = candidates.every((o) => selected.has(cleanup.key(o)));
  for (const o of candidates) {
    if (all) selected.delete(cleanup.key(o));
    else selected.add(cleanup.key(o));
  }
}

const selectedShader = computed(() =>
  shadercacheOrphans.value.filter((o) => selected.has(cleanup.key(o))),
);
const selectedCompat = computed(() =>
  compatdataOrphans.value.filter((o) => selected.has(cleanup.key(o))),
);
const selectedAll = computed(() => [...selectedShader.value, ...selectedCompat.value]);
const selectedBytes = computed(() =>
  selectedAll.value.reduce((sum, o) => sum + (o.sizeBytes ?? 0), 0),
);

const deleteCandidates = ref<OrphanEntry[]>([]);
const deleting = ref(false);

function startDelete(candidates: OrphanEntry[]) {
  if (candidates.length) deleteCandidates.value = candidates;
}

async function confirmDelete() {
  deleting.value = true;
  await cleanup.deleteOrphans(deleteCandidates.value);
  deleteCandidates.value = [];
  selected.clear();
  deleting.value = false;
  await cleanup.scanOrphans();
}

function cancelDelete() {
  deleteCandidates.value = [];
}

const confirmCompat = computed(() => deleteCandidates.value.filter((o) => o.type === "compatdata"));
const confirmTotalBytes = computed(() =>
  deleteCandidates.value.reduce((sum, o) => sum + (o.sizeBytes ?? 0), 0),
);
const confirmPaths = computed(() => deleteCandidates.value.map((o) => o.path));

const busy = computed(() => cleanup.scanning || cleanup.deleting.size > 0);
</script>

<template>
  <section class="cv">
    <header class="bar">
      <div class="title">
        <span class="label">cleanup</span>
        <h2>verwaiste daten</h2>
      </div>
    </header>

    <button class="scan-btn" type="button" :disabled="busy" @click="cleanup.scanOrphans()">
      {{ cleanup.scanning ? "suche läuft…" : "nach verwaisten daten suchen" }}
    </button>

    <div v-if="cleanup.blockedBySkipped" class="blocked">
      Scan unvollständig: Libraries wurden übersprungen. Bereinigung blockiert.
    </div>

    <div v-if="cleanup.pathMissingLibs.length" class="pathmissing">
      <p class="pm-title">Diese Libraries aus Steams Config existieren nicht:</p>
      <ul class="pm-list">
        <li v-for="p in cleanup.pathMissingLibs" :key="p">{{ p }}</li>
      </ul>
      <p class="pm-note">
        Sind das alte/entfernte Platten? Dann ist die Bereinigung sicher. Falls es abgehängte
        Platten mit Spielen sind: erst einhängen, sonst droht Datenverlust.
      </p>
      <button class="pm-btn" type="button" @click="cleanup.dismissPathMissing()">
        alte Platten ignorieren und fortfahren
      </button>
    </div>

    <div v-if="cleanup.shortcutUnreadable" class="blocked">
      shortcuts.vdf nicht lesbar — Non-Steam-Spiele können nicht identifiziert werden.
      Wine-Prefix-Bereinigung ist daher blockiert. Betroffene Dateien:
      <ul class="pm-list"><li v-for="p in cleanup.shortcutUnreadablePaths" :key="p" class="mono">{{ p }}</li></ul>
    </div>

    <div v-if="cleanup.error" class="hint">{{ cleanup.error }}</div>

    <div v-if="cleanup.orphans.length" class="summary">
      {{ cleanup.orphans.length }} verwaiste Einträge · {{ formatBytes(cleanup.totalOrphanBytes) }} freigebbar
    </div>

    <template v-if="shadercacheOrphans.length">
      <div class="section-bar">
        <h3 class="section">Shader-Caches <span class="count">{{ shadercacheOrphans.length }} </span></h3>
        <h3 class="section"> <span class="count">Insgesamt {{ formatBytes(shadercacheTotalBytes) }} </span></h3>
        <button class="sel-all" type="button" @click="selectAllShader()">alle auswählen</button>
      </div>

      <div class="list">
        <button
          v-for="o in shadercacheOrphans"
          :key="cleanup.key(o)"
          type="button"
          class="row"
          :class="{ on: selected.has(cleanup.key(o)) }"
          :aria-pressed="selected.has(cleanup.key(o))"
          @click="toggle(cleanup.key(o))"
        >
          <span class="box" aria-hidden="true" />
          <span class="rname mono">{{ o.appId }}</span>
          <span class="rpath mono" :title="o.path">{{ o.path }}</span>
          <span class="rsize mono">{{ o.sizeBytes != null ? formatBytes(o.sizeBytes) : "…" }}</span>
        </button>
      </div>
    </template>

    <template v-if="compatdataOrphans.length">
      <div class="section-bar">
        <h3 class="section">
          Wine-Prefixes
          <span class="warn-label">Vorsicht — kann lokale Spielstände enthalten!</span>
          <span class="count">{{ compatdataOrphans.length }}</span>

        </h3>
        <span class="section"> <span class="count">Insgesamt {{ formatBytes(compatdataTotalBytes) }} </span></span>
        <button class="sel-all warn" type="button" @click="selectAllCompat()">alle auswählen</button>
      </div>

      <div class="list">
        <button
          v-for="o in compatdataOrphans"
          :key="cleanup.key(o)"
          type="button"
          class="row"
          :class="{ on: selected.has(cleanup.key(o)) }"
          :aria-pressed="selected.has(cleanup.key(o))"
          @click="toggle(cleanup.key(o))"
        >
          <span class="box" aria-hidden="true" />
          <span class="rname mono">
            {{ o.appId }}
            <span v-if="o.potentialShortcut" class="sc-warn" title="möglicher Non-Steam-Shortcut — nicht via App-Manifest identifizierbar">?</span>
          </span>
          <span class="rpath mono" :title="o.path">{{ o.path }}</span>
          <span class="rsize mono">{{ o.sizeBytes != null ? formatBytes(o.sizeBytes) : "…" }}</span>
        </button>
      </div>
    </template>

    <div v-if="!cleanup.scanning && !cleanup.orphans.length && !cleanup.error" class="empty">
      keine verwaisten daten gefunden
    </div>

    <!-- sticky aktionsleiste: immer erreichbar ohne ans listenende zu scrollen -->
    <div v-if="cleanup.orphans.length" class="actionbar">
      <span class="sel-info mono">
        {{ selectedAll.length }} ausgewählt · {{ formatBytes(selectedBytes) }}
      </span>
      <div class="actionbar-btns">
        <button
          v-if="shadercacheOrphans.length"
          class="action"
          type="button"
          :disabled="busy"
          @click="startDelete(shadercacheOrphans)"
        >
          Alle Shader-Caches bereinigen
        </button>
        <button
          class="action danger"
          type="button"
          :disabled="busy || !selectedAll.length"
          @click="startDelete(selectedAll)"
        >
          {{ selectedAll.length }} - Ausgewählte löschen
        </button>
      </div>
    </div>

    <ConfirmDialog
      v-if="deleteCandidates.length"
      :title="`${deleteCandidates.length} verwaiste Einträge löschen?`"
      confirm-label="löschen"
      danger
      @cancel="cancelDelete"
      @confirm="confirmDelete"
    >
      <p v-if="confirmCompat.length" class="saveurge">
        Wine-Prefixes können lokale Spielstände enthalten, die NICHT in der Steam-Cloud liegen!
        Gelöschte Prefixes landen in .protium-trash — dort manuell wiederherstellbar.
      </p>
      <p>Gesamtgröße: {{ formatBytes(confirmTotalBytes) }}</p>
      <ul class="paths">
        <li v-for="p in confirmPaths" :key="p" class="mono">{{ p }}</li>
      </ul>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.cv { padding: 20px 24px 96px; }
.bar { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 16px; }
.title h2 { margin: 2px 0 0; font-family: var(--font-display); font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
.title .label { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.14em; color: var(--fg-2); text-transform: uppercase; }

.scan-btn {
  background: var(--bg-2); color: var(--fg-1);
  border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 10px 16px; font-family: var(--font-mono); font-size: 13px; cursor: pointer;
  margin-bottom: 16px;
}
.scan-btn:hover:not(:disabled) { color: var(--fg-0); border-color: var(--signal-dim); }
.scan-btn:disabled { opacity: 0.55; cursor: default; }

.blocked {
  background: color-mix(in srgb, var(--tier-borked) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--tier-borked) 40%, transparent);
  color: var(--tier-borked);
  border-radius: var(--r-sm);
  padding: 12px 16px;
  font-family: var(--font-mono);
  font-size: 13px;
  margin-bottom: 16px;
}

.pathmissing {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-left: 3px solid var(--signal);
  border-radius: var(--r-sm);
  padding: 14px 16px;
  margin-bottom: 16px;
}
.pm-title { margin: 0 0 8px; color: var(--fg-0); font-size: 14px; }
.pm-list { margin: 0 0 10px; padding-left: 18px; }
.pm-list li { color: var(--fg-1); font-family: var(--font-mono); font-size: 13px; line-height: 1.6; }
.pm-note { margin: 0 0 12px; color: var(--fg-2); font-size: 13px; line-height: 1.5; }
.pm-btn {
  background: var(--signal); border: none; color: var(--bg-0);
  border-radius: var(--r-sm); padding: 10px 15px;
  font-family: var(--font-display); font-weight: 600; font-size: 14px; cursor: pointer;
}
.pm-btn:hover { background: var(--signal-bright); }

.summary {
  font-family: var(--font-mono); font-size: 14px; color: var(--fg-1);
  background: var(--bg-2); border: 1px solid var(--line);
  border-radius: var(--r-sm); padding: 12px 16px; margin-bottom: 20px;
}

.section-bar { display: flex; align-items: center; justify-content: space-between; margin: 24px 0 10px; }
.section {
  font-family: var(--font-display); font-size: 16px; font-weight: 600; color: var(--fg-1);
  display: flex; align-items: center; gap: 10px;
}
.section .count { color: var(--fg-2); font-weight: 400; }
.section .warn-label {
  font-family: var(--font-mono); font-size: 11px; color: var(--tier-gold);
  border: 1px solid color-mix(in srgb, var(--tier-gold) 45%, transparent);
  border-radius: 999px; padding: 2px 9px;
}

.sel-all {
  background: none; border: 1px solid var(--line); color: var(--fg-1);
  border-radius: var(--r-sm); padding: 6px 12px;
  font-family: var(--font-mono); font-size: 12px; cursor: pointer;
}
.sel-all:hover { color: var(--fg-0); border-color: var(--signal-dim); }
.sel-all.warn:hover { border-color: var(--tier-gold); color: var(--tier-gold); }

.list { display: grid; gap: 6px; margin-bottom: 12px; }

/* ganze zeile ist die klickfläche (a11y: große trefferfläche statt mini-checkbox) */
.row {
  display: flex; align-items: center; gap: 12px;
  width: 100%; text-align: left;
  background: var(--bg-2); border: 1px solid var(--line);
  border-radius: var(--r-sm); padding: 12px 14px; cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.row:hover { border-color: var(--signal-dim); background: var(--bg-3); }
.row:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.row.on { border-color: var(--signal); background: color-mix(in srgb, var(--signal) 10%, var(--bg-2)); }

.box {
  flex-shrink: 0; width: 18px; height: 18px; border-radius: 5px;
  border: 2px solid var(--fg-2); background: transparent;
  display: grid; place-items: center; transition: all 0.12s;
}
.row.on .box { border-color: var(--signal); background: var(--signal); }
.row.on .box::after {
  content: ""; width: 5px; height: 9px; margin-top: -2px;
  border: solid var(--bg-0); border-width: 0 2px 2px 0; transform: rotate(45deg);
}

.rname { font-size: 15px; color: var(--fg-0); flex-shrink: 0; min-width: 90px; }
.sc-warn {
  display: inline-block; width: 16px; height: 16px; line-height: 16px; text-align: center;
  border-radius: 50%; font-size: 11px; font-weight: 700; margin-left: 4px;
  background: color-mix(in srgb, var(--tier-gold) 20%, transparent);
  color: var(--tier-gold); border: 1px solid color-mix(in srgb, var(--tier-gold) 40%, transparent);
}
.rpath {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--fg-2); font-size: 12px;
}
.rsize { color: var(--fg-1); font-size: 14px; white-space: nowrap; flex-shrink: 0; }

/* sticky aktionsleiste unten */
.actionbar {
  position: sticky; bottom: 0; z-index: 5;
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  margin: 16px -24px -96px; padding: 14px 24px;
  background: color-mix(in srgb, var(--bg-1) 92%, transparent);
  backdrop-filter: blur(8px);
  border-top: 1px solid var(--line);
}
.sel-info { font-size: 13px; color: var(--fg-1); }
.actionbar-btns { display: flex; gap: 10px; }

.action {
  background: var(--signal); color: var(--bg-0); border: none;
  border-radius: var(--r-sm); padding: 10px 16px;
  font-family: var(--font-display); font-weight: 600; font-size: 14px; cursor: pointer;
}
.action:hover:not(:disabled) { background: var(--signal-bright); }
.action:disabled { opacity: 0.4; cursor: default; }
.action.danger {
  background: color-mix(in srgb, var(--tier-borked) 18%, transparent);
  color: var(--tier-borked);
  border: 1px solid color-mix(in srgb, var(--tier-borked) 45%, transparent);
}
.action.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--tier-borked) 30%, transparent); }

.hint { color: var(--tier-gold); font-family: var(--font-mono); font-size: 13px; margin-bottom: 12px; }
.empty { color: var(--fg-2); font-family: var(--font-mono); font-size: 14px; padding: 32px 0; text-align: center; }

.paths { margin: 8px 0 0; padding-left: 18px; color: var(--fg-1); max-height: 160px; overflow-y: auto; }
.paths li { font-size: 12px; margin: 2px 0; }
.saveurge {
  background: color-mix(in srgb, var(--tier-borked) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--tier-borked) 35%, transparent);
  color: var(--tier-borked); border-radius: var(--r-sm);
  padding: 10px 14px; font-family: var(--font-display); font-size: 13px; font-weight: 600; margin-bottom: 12px;
}
</style>
