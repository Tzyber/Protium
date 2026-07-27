<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { CompatTool } from "../../core/types";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { formatBytes } from "../format";
import type { Key } from "../i18n";
import { t } from "../i18n";
import type { Phase } from "../stores/protonStore";
import { useProtonStore } from "../stores/protonStore";
import { useScanStore } from "../stores/scanStore";
import { useUiStore } from "../stores/uiStore";

const proton = useProtonStore();
const scan = useScanStore();
const ui = useUiStore();

onMounted(() => proton.init());

// appId → name, um usedBy in klarnamen aufzulösen
const nameOf = computed(() => new Map(scan.games.map((g) => [g.appId, g.name])));

function removable(tt: CompatTool): boolean {
  return tt.source === "user" && /^GE-Proton/i.test(tt.name);
}

const installedInternal = computed(
  () => new Set(proton.installedTools.map((tt) => tt.internalName)),
);

// remove-confirm-state
const toRemove = ref<CompatTool | null>(null);
const removeGames = computed(() =>
  toRemove.value
    ? toRemove.value.usedBy.map((id) => nameOf.value.get(id) ?? t("proton.appId", { id }))
    : [],
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

// literale keys statt laufzeit-konkatenation: fehlt eine übersetzung, schlägt
// der typecheck fehl statt erst die UI.
const PHASE_KEYS = {
  queued: "phase.queued",
  downloading: "phase.downloading",
  verifying: "phase.verifying",
  extracting: "phase.extracting",
} as const satisfies Record<Phase, Key>;

function phaseLabel(tag: string): string {
  const phase = proton.jobs[tag]?.phase;
  return phase ? t(PHASE_KEYS[phase]) : "";
}

function relTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return t("time.justNow");
  const m = Math.round(s / 60);
  if (m < 60) return t("time.minutesAgo", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("time.hoursAgo", { n: h });
  return t("time.daysAgo", { n: Math.round(h / 24) });
}

const statusFlash = ref(false);
async function refreshReleases() {
  await proton.loadReleases(true); // expliziter klick → cache umgehen
  statusFlash.value = true;
  setTimeout(() => {
    statusFlash.value = false;
  }, 1400);
}

const statusLine = computed(() => {
  if (proton.loading) return null;
  if (proton.lastFetchedAt == null) return null;
  const when = relTime(proton.lastFetchedAt);
  const n = proton.releases.length;
  switch (proton.lastSource) {
    case "fresh":
      return { icon: "✓", text: t("proton.statusUpdated", { n }), ok: true };
    case "not-modified":
      return { icon: "✓", text: t("proton.statusCurrent", { when }), ok: true };
    case "cache":
      return { icon: "✓", text: t("proton.statusCurrent", { when }), ok: true };
    case "offline":
      return { icon: "⚠", text: t("proton.statusOffline", { when }), ok: false };
    default:
      return null;
  }
});
</script>

<template>
  <section class="pm">
    <header class="bar">
      <div class="title">
        <span class="label">{{ t("proton.label") }}</span>
        <h2>{{ t("proton.versions") }}</h2>
      </div>
      <div class="update">
        <button class="rescan" type="button" :disabled="proton.loading" @click="refreshReleases">
          {{ proton.loading ? t("proton.loading") : t("proton.refreshReleases") }}
        </button>
        <div
          v-if="statusLine"
          class="statusline"
          :class="{ warn: !statusLine.ok, flash: statusFlash }"
        >
          <span class="ic">{{ statusLine.icon }}</span> {{ statusLine.text }}
        </div>
      </div>
    </header>

    <!-- installiert -->
    <h3 class="section">{{ t("proton.installed") }} <span class="count">{{ proton.installedTools.length }}</span></h3>
    <div class="list">
      <div v-for="tt in proton.installedTools" :key="tt.name" class="row">
        <div class="rmain">
          <div class="rname">{{ tt.displayName }}</div>
          <div class="rsub mono">
            {{ tt.internalName }} · {{ formatBytes(tt.sizeBytes) }}
            <span v-if="tt.source === 'system'" class="tag distro">{{ t("proton.distroReadonly") }}</span>
          </div>
        </div>
        <button v-if="tt.usedBy.length" class="used" type="button" @click="ui.showLibraryForTool(tt.internalName)">
          {{ t("proton.usedBy", { n: tt.usedBy.length }) }}
        </button>
        <span v-else class="used muted">{{ t("proton.unused") }}</span>
        <button
          v-if="removable(tt)"
          class="rm"
          type="button"
          :disabled="proton.busyRemove === tt.name"
          @click="toRemove = tt"
        >
          {{ proton.busyRemove === tt.name ? "…" : t("common.delete") }}
        </button>
        <span v-else class="rm-lock" :title="t('proton.notManageable')">🔒</span>
      </div>
    </div>

    <!-- verfügbar -->
    <h3 class="section">{{ t("proton.geReleases") }}</h3>
    <div v-if="proton.loadError" class="hint">{{ proton.loadError }}</div>
    <div class="list">
      <div v-for="r in proton.releases" :key="r.tag" class="row">
        <div class="rmain">
          <div class="rname">
            {{ r.tag }}
            <span v-if="installedInternal.has(r.tag)" class="tag ok">{{ t("proton.tagInstalled") }}</span>
          </div>
          <div class="rsub mono">{{ formatBytes(r.tarball.size) }}</div>
          <div v-if="proton.jobs[r.tag]" class="progress">
            <template v-if="proton.jobs[r.tag]?.phase === 'downloading'">
              <div class="track"><div class="fill" :style="{ width: (pct(r.tag) ?? 30) + '%' }" /></div>
              <span class="phase">{{ phaseLabel(r.tag) }}<span v-if="pct(r.tag) !== null"> · {{ pct(r.tag) }}%</span></span>
            </template>
            <span v-else class="phase act">{{ phaseLabel(r.tag) }}</span>
          </div>
        </div>
        <button
          v-if="!installedInternal.has(r.tag) && !proton.jobs[r.tag]"
          class="install"
          type="button"
          @click="proton.queueInstall(r)"
        >
          {{ t("proton.install") }}
        </button>
        <button
          v-else-if="proton.jobs[r.tag]"
          class="cancel"
          type="button"
          :title="proton.activeTag === r.tag ? t('proton.cancelDownload') : t('proton.cancelQueue')"
          @click="proton.cancel(r.tag)"
        >
          ✕ {{ t("proton.cancel") }}
        </button>
        <span v-else class="used muted">✓</span>
      </div>
    </div>

    <ConfirmDialog
      v-if="toRemove"
      :title="t('proton.deleteTitle', { name: toRemove.displayName })"
      :confirm-label="t('common.delete')"
      danger
      @cancel="toRemove = null"
      @confirm="confirmRemove"
    >
      <template v-if="removeGames.length">
        <p>{{ t("proton.usedByConfirm", { n: removeGames.length }) }}</p>
        <ul class="games">
          <li v-for="g in removeGames" :key="g">{{ g }}</li>
        </ul>
      </template>
      <p v-else>{{ t("proton.unusedConfirm") }}</p>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.pm { padding: 20px 24px; }
.bar { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 20px; }
.update { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.statusline {
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--fg-1);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  transition: background 0.3s, border-color 0.3s, color 0.3s;
}
.statusline .ic { color: var(--tier-platinum); font-size: 16px; }
.statusline.warn { color: var(--tier-gold); }
.statusline.warn .ic { color: var(--tier-gold); }
.statusline.flash {
  color: var(--signal-bright);
  border-color: var(--signal);
  background: color-mix(in srgb, var(--signal) 16%, transparent);
}
.title h2 { margin: 2px 0 0; font-family: var(--font-display); font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }

.rescan {
  background: var(--bg-2); color: var(--fg-1);
  border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 8px 14px; font-family: var(--font-body); font-size: 14px; cursor: pointer;
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
.rsub { color: var(--fg-2); font-size: 13px; font-weight: 600; margin-top: 3px; }

.tag { font-family: var(--font-body); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; padding: 2px 6px; border-radius: 999px; }
.tag.ok { color: var(--tier-platinum); background: color-mix(in srgb, var(--tier-platinum) 14%, transparent); }
.tag.distro { color: var(--fg-2); border: 1px solid var(--line); margin-left: 8px; }

.used { background: none; border: 1px solid var(--signal-dim); color: var(--signal-bright); border-radius: var(--r-sm); padding: 5px 9px; font-family: var(--font-body); font-size: 14px; cursor: pointer; white-space: nowrap; }
.used.muted { color: var(--fg-2); border-color: var(--line); cursor: default; }

.rm { background: none; border: 1px solid color-mix(in srgb, var(--tier-borked) 45%, transparent); color: var(--tier-borked); border-radius: var(--r-sm); padding: 5px 10px; font-family: var(--font-body); font-size: 14px; cursor: pointer; }
.rm:hover:not(:disabled) { background: color-mix(in srgb, var(--tier-borked) 14%, transparent); }
.rm-lock { color: var(--fg-2); font-size: 13px; }

.install { background: var(--signal); color: #0a0b11; border: none; border-radius: var(--r-sm); padding: 7px 14px; font-family: var(--font-display); font-weight: 600; font-size: 13px; cursor: pointer; }
.install:hover:not(:disabled) { background: var(--signal-bright); }
.install:disabled { opacity: 0.55; cursor: default; }
.cancel {
  background: none;
  border: 1px solid color-mix(in srgb, var(--tier-borked) 50%, transparent);
  color: var(--tier-borked);
  border-radius: var(--r-sm);
  padding: 7px 12px;
  font-family: var(--font-body);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.cancel:hover { background: color-mix(in srgb, var(--tier-borked) 14%, transparent); }

.progress { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.track { flex: 1; max-width: 320px; height: 5px; background: var(--bg-0); border-radius: 999px; overflow: hidden; }
.fill { height: 100%; background: var(--signal); transition: width 0.2s; }
.phase { color: var(--fg-2); font-size: 12px; }
.phase.act::before {
  content: "·";
  display: inline-block;
  animation: phase-pulse 1s ease-in-out infinite;
}
.phase.act { color: var(--signal-bright); }
@keyframes phase-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .phase.act::before { opacity: 0.6; animation: none; }
}

.hint { color: var(--tier-gold); font-family: var(--font-body); font-size: 12px; margin-bottom: 10px; }
.games { margin: 8px 0 0; padding-left: 18px; color: var(--fg-1); }
.games li { margin: 2px 0; }
</style>
