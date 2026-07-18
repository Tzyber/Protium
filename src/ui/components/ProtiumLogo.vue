<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 22 });

const animate =
  typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
        v-if="animate"
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
      <circle r="1.9" fill="currentColor" :opacity="animate ? undefined : 0.9" :cx="animate ? undefined : 4" :cy="animate ? undefined : 16">
        <template v-if="animate">
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
