<template>
  <UiBadge :variant="variant" dot :pulse="pulsing" class="status-badge" :data-status="status">
    {{ label }}
  </UiBadge>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'

const props = defineProps<{ status: string }>()

type BadgeVariant = InstanceType<typeof UiBadge>['$props']['variant']

const VARIANTS: Record<string, BadgeVariant> = {
  Queued: 'neutral',
  Pending: 'neutral',
  Running: 'running',
  // Waiting for a person: always carries text so colour is never the only cue.
  Paused: 'paused',
  WaitingForBreakpoint: 'paused',
  Retrying: 'warning',
  Cancelling: 'warning',
  Succeeded: 'success',
  Failed: 'danger',
  Cancelled: 'neutral',
  Skipped: 'neutral',
}
const variant = computed<BadgeVariant>(() => VARIANTS[props.status] ?? 'neutral')
const label = computed(() => props.status.replace(/([a-z])([A-Z])/g, '$1 $2'))
const pulsing = computed(() => ['Running', 'Cancelling', 'Retrying'].includes(props.status))
</script>

<style scoped>
.status-badge {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.6875rem;
}
</style>
