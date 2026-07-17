<script setup lang="ts">
defineProps<{ title: string; confirmLabel?: string; danger?: boolean }>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <div class="backdrop" @click.self="emit('cancel')">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>{{ title }}</h3>
      <div class="content"><slot /></div>
      <div class="actions">
        <button class="btn ghost" type="button" @click="emit('cancel')">abbrechen</button>
        <button class="btn" :class="{ danger }" type="button" @click="emit('confirm')">
          {{ confirmLabel ?? "bestätigen" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(4, 5, 9, 0.6);
  backdrop-filter: blur(2px);
  display: grid;
  place-items: center;
  z-index: 50;
}
.dialog {
  width: min(460px, 92vw);
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 20px;
  box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.7);
}
h3 {
  margin: 0 0 12px;
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
}
.content { color: var(--fg-1); font-size: 13px; margin-bottom: 18px; }
.actions { display: flex; justify-content: flex-end; gap: 10px; }
.btn {
  border: 1px solid var(--signal);
  background: var(--signal);
  color: #0a0b11;
  border-radius: var(--r-sm);
  padding: 8px 14px;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
}
.btn.ghost { background: transparent; color: var(--fg-1); border-color: var(--line); }
.btn.ghost:hover { color: var(--fg-0); border-color: var(--signal-dim); }
.btn.danger { background: var(--tier-borked); border-color: var(--tier-borked); color: #fff; }
</style>
