<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

withDefaults(defineProps<{ size?: number }>(), { size: 22 });

const reduced = ref(
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
);

let mq: MediaQueryList | null = null;

onMounted(() => {
  mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  const handler = (e: MediaQueryListEvent) => {
    reduced.value = e.matches;
  };
  mq.addEventListener("change", handler);
  onBeforeUnmount(() => {
    mq?.removeEventListener("change", handler);
  });
});
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    fill="none"
    aria-hidden="true"
  >
    <!-- kern: das eine proton -->
    <circle cx="16" cy="16" r="3.2" fill="currentColor">
      <animate
        v-if="!reduced"
        attributeName="r"
        values="3.2;3.7;3.2"
        dur="2.6s"
        repeatCount="indefinite"
        calcMode="spline"
        keySplines=".4 0 .6 1;.4 0 .6 1"
      />
    </circle>

    <!-- orbit + das eine elektron -->
    <g transform="rotate(-28 16 16)">
      <ellipse
        cx="16"
        cy="16"
        rx="12"
        ry="5.2"
        stroke="currentColor"
        stroke-width="1.4"
        opacity="0.35"
      />
      <circle r="1.9" fill="currentColor" :opacity="!reduced ? undefined : 0.9" :cx="!reduced ? undefined : 4" :cy="!reduced ? undefined : 16">
        <template v-if="!reduced">
          <animateMotion
            dur="3.2s"
            repeatCount="indefinite"
            path="M 4 16 a 12 5.2 0 1 0 24 0 a 12 5.2 0 1 0 -24 0"
          />
          <animate
            attributeName="opacity"
            values="1;0.35;1"
            keyTimes="0;0.5;1"
            dur="3.2s"
            repeatCount="indefinite"
          />
        </template>
      </circle>
    </g>
  </svg>
</template>
