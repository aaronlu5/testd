<template>
  <UiAlert v-if="view" :variant="view.variant" class="problem" data-testid="problem-alert">
    <div class="problem__title" data-testid="problem-title">{{ view.title }}</div>
    <div data-testid="problem-detail">{{ view.detail }}</div>

    <ul v-if="view.issues.length > 0" class="problem__issues" data-testid="problem-issues">
      <li v-for="(issue, index) in view.issues" :key="index">
        <code>{{ describeIssuePath(issue.path) }}</code> {{ issue.message }}
      </li>
    </ul>

    <div class="problem__meta td-small td-muted">
      <UiBadge v-if="view.code">{{ view.code }}</UiBadge>
      <span v-if="view.status">HTTP {{ view.status }}</span>
      <span v-if="view.requestId">Request ID: {{ view.requestId }}</span>
      <UiButton
        v-if="view.connection && retryable"
        size="sm"
        variant="outline-secondary"
        @click="emit('retry')"
        >Try again</UiButton
      >
    </div>
  </UiAlert>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import UiAlert from '~/components/ui/UiAlert.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import { describeError, describeIssuePath } from '~/components/platform/problem'

const props = defineProps<{ error: unknown; retryable?: boolean }>()
const emit = defineEmits<{ retry: [] }>()

const view = computed(() => (props.error ? describeError(props.error) : undefined))
</script>

<style scoped>
.problem {
  margin-bottom: var(--td-space-4);
}
.problem__title {
  font-weight: 650;
}
.problem__issues {
  margin: var(--td-space-2) 0 0;
  padding-left: var(--td-space-5);
}
.problem__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--td-space-2);
  margin-top: var(--td-space-2);
}
</style>
