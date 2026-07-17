<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { CompatTool } from "../../core/types";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { formatBytes } from "../format";
import { useProtonStore } from "../stores/protonStore";
import { useScanStore } from "../stores/scanStore";
import { useUiStore } from "../stores/uiStore";

const proton = useProtonStore();
const scan = useScanStore();
const ui = useUiStore();

onMounted(() => proton.init());

// appId → name, um usedBy in klarnamen aufzulösen
const nameOf = computed(() => new Map(scan.games.map((g) => [g.appId, g.name])));

function removable(t: CompatTool): boolean {
  return t.source === "user" && /^GE-Proton/i.test(t.name);
}

const installedInternal = computed(() => new Set(proton.installedTools.map((t) => t.internalName)));

// remove-confirm-state
const toRemove = ref<CompatTool | null>(null);
const removeGames = computed(() =>
  toRemove.value ? toRemove.value.usedBy.map((id) => nameOf.value.get(id) ?? `app ${id}`) : [],
);
function confirmRemove() {
  if (toRemove.value) proton.remove(toRemove.value);
  toRemove.value = null;
}

function pct(tag: string): number | null {
  const j = proton.jobs[tag];
  if (!j?.total) return null;
  return Math.min(100, Math.round((j.downloaded / j.total) * 100));
}
</script>

<template>
  <section class="pm">
    <header class="bar">
      <div class="title">
        <span class="label">proton</span>
        <h2>versionen</h2>
      </div>
      <button class="rescan" type="button" :disabled="proton.loading" @click="proton.loadReleases()">
        {{ proton.loading ? "lädt…" : "releases aktualisieren" }}
      </button>
    </header>

    <!-- installiert -->
    <h3 class="section">installiert <span class="count">{{ proton.installedTools.length }}</span></h3>
    <div class="list">
      <div v-for="t in proton.installedTools" :key="t.name" class="row">
        <div class="rmain">
          <div class="rname">{{ t.displayName }}</div>
          <div class="rsub mono">
            {{ t.internalName }} · {{ formatBytes(t.sizeBytes) }}
            <span v-if="t.source === 'system'" class="tag distro">distro · read-only</span>
          </div>
        </div>
        <button v-if="t.usedBy.length" class="used" type="button" @click="ui.showLibraryForTool(t.internalName)">
          {{ t.usedBy.length }} spiel(e) →
        </button>
        <span v-else class="used muted">ungenutzt</span>
        <button
          v-if="removable(t)"
          class="rm"
          type="button"
          :disabled="proton.busyRemove === t.name"
          @click="toRemove = t"
        >
          {{ proton.busyRemove === t.name ? "…" : "löschen" }}
        </button>
        <span v-else class="rm-lock" title="nicht über protium verwaltbar">🔒</span>
      </div>
    </div>

    <!-- verfügbar -->
    <h3 class="section">GE-Proton releases</h3>
    <div v-if="proton.loadError" class="hint">{{ proton.loadError }}</div>
    <div class="list">
      <div v-for="r in proton.releases" :key="r.tag" class="row">
        <div class="rmain">
          <div class="rname">
            {{ r.tag }}
            <span v-if="installedInternal.has(r.tag)" class="tag ok">installiert</span>
          </div>
          <div class="rsub mono">{{ formatBytes(r.tarball.size) }}</div>
          <div v-if="proton.jobs[r.tag]" class="progress">
            <div class="track"><div class="fill" :style="{ width: (pct(r.tag) ?? 30) + '%' }" /></div>
            <span class="phase mono">{{ proton.jobs[r.tag]?.phase }}<span v-if="pct(r.tag) !== null"> · {{ pct(r.tag) }}%</span></span>
          </div>
        </div>
        <button
          v-if="!installedInternal.has(r.tag)"
          class="install"
          type="button"
          :disabled="!!proton.jobs[r.tag]"
          @click="proton.queueInstall(r)"
        >
          {{ proton.jobs[r.tag] ? "…" : "installieren" }}
        </button>
        <span v-else class="used muted">✓</span>
      </div>
    </div>

    <ConfirmDialog
      v-if="toRemove"
      :title="`${toRemove.displayName} löschen?`"
      confirm-label="löschen"
      danger
      @cancel="toRemove = null"
      @confirm="confirmRemove"
    >
      <template v-if="removeGames.length">
        <p>diese version wird von {{ removeGames.length }} spiel(en) genutzt — steam fällt danach auf „default" zurück:</p>
        <ul class="games">
          <li v-for="g in removeGames" :key="g">{{ g }}</li>
        </ul>
      </template>
      <p v-else>das verzeichnis wird entfernt. keine spiele nutzen diese version.</p>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.pm { padding: 20px 24px; }
.bar { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 20px; }
.title h2 { margin: 2px 0 0; font-family: var(--font-display); font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }

.rescan {
  background: var(--bg-2); color: var(--fg-1);
  border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 8px 14px; font-family: var(--font-mono); font-size: 12px; cursor: pointer;
}
.rescan:hover:not(:disabled) { color: var(--fg-0); border-color: var(--signal-dim); }

.section { font-family: var(--font-display); font-size: 14px; font-weight: 600; margin: 22px 0 10px; color: var(--fg-1); }
.section .count { color: var(--fg-2); font-weight: 400; }

.list { display: grid; gap: 8px; }
.row {
  display: flex; align-items: center; gap: 14px;
  background: var(--bg-2); border: 1px solid var(--line);
  border-radius: var(--r-md); padding: 12px 14px;
}
.rmain { flex: 1; min-width: 0; }
.rname { font-family: var(--font-display); font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.rsub { color: var(--fg-2); font-size: 11px; margin-top: 3px; }

.tag { font-family: var(--font-mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; padding: 2px 6px; border-radius: 999px; }
.tag.ok { color: var(--tier-platinum); background: color-mix(in srgb, var(--tier-platinum) 14%, transparent); }
.tag.distro { color: var(--fg-2); border: 1px solid var(--line); margin-left: 8px; }

.used { background: none; border: 1px solid var(--signal-dim); color: var(--signal-bright); border-radius: var(--r-sm); padding: 5px 9px; font-family: var(--font-mono); font-size: 11px; cursor: pointer; white-space: nowrap; }
.used.muted { color: var(--fg-2); border-color: var(--line); cursor: default; }

.rm { background: none; border: 1px solid color-mix(in srgb, var(--tier-borked) 45%, transparent); color: var(--tier-borked); border-radius: var(--r-sm); padding: 5px 10px; font-family: var(--font-mono); font-size: 11px; cursor: pointer; }
.rm:hover:not(:disabled) { background: color-mix(in srgb, var(--tier-borked) 14%, transparent); }
.rm-lock { color: var(--fg-2); font-size: 13px; }

.install { background: var(--signal); color: #0a0b11; border: none; border-radius: var(--r-sm); padding: 7px 14px; font-family: var(--font-display); font-weight: 600; font-size: 13px; cursor: pointer; }
.install:hover:not(:disabled) { background: var(--signal-bright); }
.install:disabled { opacity: 0.55; cursor: default; }

.progress { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.track { flex: 1; max-width: 320px; height: 5px; background: var(--bg-0); border-radius: 999px; overflow: hidden; }
.fill { height: 100%; background: var(--signal); transition: width 0.2s; }
.phase { color: var(--fg-2); font-size: 10px; }

.hint { color: var(--tier-gold); font-family: var(--font-mono); font-size: 12px; margin-bottom: 10px; }
.games { margin: 8px 0 0; padding-left: 18px; color: var(--fg-1); }
.games li { margin: 2px 0; }
</style>
