<template>
  <pre class="json-view" tabindex="0" :aria-label="label" :data-testid="testid">{{ text }}</pre>
</template>

<script setup lang="ts">
import { computed } from 'vue'

// Values reach the browser already masked by the API; this component only displays them.
const props = defineProps<{ value: unknown; label?: string; testid?: string }>()

const text = computed(() => {
  if (props.value === undefined) return ''
  return typeof props.value === 'string' ? props.value : JSON.stringify(props.value, null, 2)
})
</script>

<style scoped>
.json-view {
  max-height: 20rem;
  margin: 0;
  overflow: auto;
  font-size: var(--td-text-xs);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
