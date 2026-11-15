<template>
  <PageHeader title="API Status" subtitle="Test Platform" />

  <UiCard title="API connectivity" data-testid="api-status">
    <template #actions>
      <UiButton size="sm" variant="outline-primary" :disabled="isFetching" @click="() => refetch()"
        >Check again</UiButton
      >
    </template>

    <LoadingState v-if="isPending" label="Checking API readiness…" />

    <UiAlert v-else-if="isError" variant="warning" data-testid="api-unavailable">
      <div class="status__title">API unavailable</div>
      <div>{{ errorMessage }}</div>
      <div class="td-small td-muted status__meta">
        Endpoint: {{ baseUrl }}/health/ready<span v-if="requestId">
          · Request ID: {{ requestId }}</span
        >
      </div>
    </UiAlert>

    <UiAlert v-else variant="success" data-testid="api-ready">
      <div class="status__title">API ready</div>
      <pre class="status__json" tabindex="0">{{ JSON.stringify(data, null, 2) }}</pre>
    </UiAlert>
  </UiCard>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import PageHeader from '~/components/PageHeader.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import UiAlert from '~/components/ui/UiAlert.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'
import { ApiError, getApiBaseUrl } from '~/api/client'
import { getReadiness } from '~/api/health'

const baseUrl = getApiBaseUrl()

const { data, error, isPending, isError, isFetching, refetch } = useQuery({
  queryKey: ['health', 'ready'],
  queryFn: ({ signal }) => getReadiness({ signal }),
  retry: false,
})

const errorMessage = computed(() =>
  error.value instanceof ApiError
    ? error.value.message
    : 'Unexpected error while contacting the API.',
)
const requestId = computed(() =>
  error.value instanceof ApiError ? error.value.requestId : undefined,
)
</script>

<style scoped>
.status__title {
  font-weight: 650;
}
.status__meta {
  margin-top: var(--td-space-1);
}
.status__json {
  margin: var(--td-space-2) 0 0;
  font-size: var(--td-text-xs);
}
</style>
