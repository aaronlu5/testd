<template>
  <component
    :is="glyph"
    class="td-icon"
    :size="size"
    :stroke-width="strokeWidth"
    :aria-hidden="label ? undefined : 'true'"
    :aria-label="label"
    :role="label ? 'img' : undefined"
    focusable="false"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { icons, type IconName } from './icons'

const props = withDefaults(
  defineProps<{
    /** Registry name; unknown names render nothing visible rather than throwing. */
    name: IconName | (string & {})
    size?: number | string
    strokeWidth?: number | string
    /** Accessible name. Omit for decorative icons. */
    label?: string
  }>(),
  { size: 18, strokeWidth: 1.75, label: undefined },
)

const glyph = computed(() => (icons as Record<string, unknown>)[props.name] ?? icons['help-circle'])
</script>

<style scoped>
.td-icon {
  flex: none;
  vertical-align: -0.2em;
}
</style>
