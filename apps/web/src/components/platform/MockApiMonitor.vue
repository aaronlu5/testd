<template>
  <TopbarToggle
    id="mock-api-monitor-toggler"
    :label="`Mock API server: ${stateLabel}${unread > 0 ? `, ${unread} new request${unread === 1 ? '' : 's'}` : ''}`"
    :title="`Mock API server: ${stateLabel}`"
    data-testid="mock-api-toggle"
    @click="open = true"
  >
    <Icon name="api" :size="20" />
    <template #overlay>
      <span
        class="mock-dot"
        :class="`mock-dot--${state}`"
        :data-state="state"
        data-testid="mock-api-dot"
        aria-hidden="true"
      />
      <span v-if="unread > 0" class="mock-badge" data-testid="mock-api-badge">{{
        unread > 99 ? '99+' : unread
      }}</span>
    </template>
  </TopbarToggle>

  <UiDrawer v-model="open" title="Mock API server" size="lg" data-testid="mock-api-panel">
    <div class="panel__head">
      <div class="td-row">
        <UiBadge :variant="stateVariant" data-testid="mock-api-state">{{ stateBadge }}</UiBadge>
        <code v-if="status" data-testid="mock-api-address">{{ status.baseUrl }}</code>
        <span v-if="status?.running" class="td-small td-muted"
          >{{ status.activeRuns }} active Run{{ status.activeRuns === 1 ? '' : 's' }} with
          setups</span
        >
        <div class="td-spacer"></div>
        <UiButton to="/mock-api" size="sm" variant="outline-secondary" @click="open = false"
          >Setups</UiButton
        >
        <UiButton
          size="sm"
          variant="outline-danger"
          :disabled="items.length === 0 || clearing"
          data-testid="mock-api-clear"
          @click="clear"
        >
          <Icon name="trash" :size="14" />Clear
        </UiButton>
      </div>
      <p v-if="status && !status.running" class="panel__note panel__note--bad td-small">
        {{ status.message ?? 'The Mock API server is not running.' }}
      </p>
      <p v-else-if="status && status.activeRuns === 0" class="panel__note td-small td-muted">
        The server is up. It answers once a Test or Suite that uses a setup is running; until then
        every request gets a 404.
      </p>
      <p class="panel__note td-small td-muted" data-testid="mock-api-count">
        {{ page?.total ?? 0 }} request{{ page?.total === 1 ? '' : 's' }} logged<template
          v-if="page && page.total >= page.maxRecords"
          >; the oldest are dropped beyond {{ page.maxRecords }}</template
        >.
      </p>
    </div>

    <ProblemAlert :error="error" retryable @retry="() => refetch()" />
    <LoadingState v-if="isPending" label="Loading requests…" />
    <EmptyState
      v-else-if="!error && items.length === 0"
      title="No requests yet"
      description="Requests the system under test sends to the Mock API server appear here, with the response each one got."
    />
    <ul v-else class="requests" data-testid="mock-api-requests">
      <li
        v-for="item in items"
        :key="item.id"
        class="request"
        :class="{ 'is-new': item.id > highlightAfter }"
        data-testid="mock-api-request"
      >
        <details>
          <summary class="request__summary">
            <span class="td-muted td-small request__time">{{ time(item.at) }}</span>
            <UiBadge>{{ item.method }}</UiBadge>
            <code class="request__path">{{ item.path }}{{ item.query }}</code>
            <UiBadge :variant="statusVariant(item.status)" data-testid="mock-api-request-status">{{
              item.status
            }}</UiBadge>
          </summary>
          <div class="request__detail td-small">
            <p>
              <template v-if="item.matched">
                Answered by <strong>{{ item.setupName ?? 'a setup' }}</strong
                >, rule {{ item.ruleNumber
                }}<template v-if="item.ruleName"> “{{ item.ruleName }}”</template>.
              </template>
              <template v-else>No rule matched, so the server answered 404.</template>
            </p>
            <div class="request__label">Request</div>
            <dl class="request__headers">
              <template v-for="(value, name) in item.requestHeaders" :key="name">
                <dt>{{ name }}:&nbsp;</dt>
                <dd>{{ value }}<br /></dd>
              </template>
            </dl>
            <pre v-if="item.requestBody">{{ item.requestBody }}</pre>
            <p v-else class="td-muted">No request body.</p>
            <p v-if="item.requestBodyTruncated" class="request__warn">
              The request body is shown in part.
            </p>
            <div class="request__label">Response {{ item.status }}</div>
            <pre v-if="item.responseBody">{{ item.responseBody }}</pre>
            <p v-else class="td-muted">No response body.</p>
          </div>
        </details>
      </li>
    </ul>
    <UiButton
      v-if="hasMore"
      class="td-mt-2"
      size="sm"
      variant="outline-secondary"
      data-testid="mock-api-more"
      @click="limit += 100"
      >Show older requests</UiButton
    >
  </UiDrawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import EmptyState from '~/components/platform/EmptyState.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import TopbarToggle from '~/components/platform/TopbarToggle.vue'
import Icon from '~/components/ui/Icon.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiDrawer from '~/components/ui/UiDrawer.vue'
import { useClearMockApiRequests, useMockApiRequests, useMockApiStatus } from '~/api/queries'

const open = ref(false)
const limit = ref(100)

// The icon is polled slowly in the background and quickly while the panel is open.
const { data: status } = useMockApiStatus(() => (open.value ? 2000 : 5000))
const { data: page, isPending, error, refetch } = useMockApiRequests(limit, () => open.value)
const clearMutation = useClearMockApiRequests()
const clearing = computed(() => clearMutation.isPending.value)

const items = computed(() => page.value?.items ?? [])
const hasMore = computed(() => (page.value?.total ?? 0) > items.value.length)

/** 'down' = not running, 'idle' = up with nothing to serve, 'serving' = answering for a Run. */
const state = computed<'unknown' | 'down' | 'idle' | 'serving'>(() => {
  if (!status.value) return 'unknown'
  if (!status.value.running) return 'down'
  return status.value.activeRuns > 0 ? 'serving' : 'idle'
})
const stateLabel = computed(
  () =>
    ({
      unknown: 'checking',
      down: 'not running',
      idle: 'running, nothing to serve',
      serving: 'running and serving a Run',
    })[state.value],
)
const stateBadge = computed(
  () =>
    ({
      unknown: 'Checking…',
      down: 'Not running',
      idle: 'Running · idle',
      serving: 'Running · serving',
    })[state.value],
)
const stateVariant = computed(
  () =>
    (
      ({
        unknown: 'neutral',
        down: 'danger',
        idle: 'success',
        serving: 'running',
      }) as const
    )[state.value],
)

/**
 * Requests up to this id were seen before the panel opened; newer ones are outlined until it
 * closes. The badge counts requests that arrived since the panel was last open (none on load).
 */
const viewedId = ref<number>()
const highlightAfter = ref(0)
const unread = computed(() => {
  const last = status.value?.lastRequestId ?? 0
  return viewedId.value === undefined ? 0 : Math.max(last - viewedId.value, 0)
})
watch(
  () => status.value?.lastRequestId,
  (last) => {
    if (last !== undefined && viewedId.value === undefined) viewedId.value = last
    if (open.value && last !== undefined) viewedId.value = last
  },
  { immediate: true },
)
watch(open, (isOpen) => {
  if (isOpen) {
    highlightAfter.value = viewedId.value ?? 0
    limit.value = 100
    viewedId.value = status.value?.lastRequestId ?? viewedId.value
  }
})

const clear = () => {
  clearMutation.mutate(undefined, {
    onSuccess: () => {
      highlightAfter.value = 0
      viewedId.value = 0
    },
  })
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false })
const statusVariant = (code: number) =>
  code >= 500 ? 'danger' : code >= 400 ? 'warning' : code >= 300 ? 'info' : 'success'
</script>

<style scoped>
.mock-dot {
  position: absolute;
  top: 0.4rem;
  right: 0.4rem;
  width: 0.5625rem;
  height: 0.5625rem;
  background: var(--td-text-faint);
  border: 1.5px solid var(--td-surface);
  border-radius: 50%;
}
.mock-dot--idle {
  background: var(--td-success);
}
.mock-dot--serving {
  background: var(--td-running);
  animation: mock-pulse 1.6s ease-in-out infinite;
}
.mock-dot--down {
  background: var(--td-danger);
}
.mock-badge {
  position: absolute;
  top: -0.125rem;
  right: -0.25rem;
  min-width: 1.125rem;
  padding: 0 0.25rem;
  font-size: 0.625rem;
  font-weight: 700;
  line-height: 1.125rem;
  text-align: center;
  color: var(--td-on-accent);
  background: var(--td-accent);
  border-radius: var(--td-radius-pill);
}
@keyframes mock-pulse {
  50% {
    opacity: 0.4;
  }
}
@media (prefers-reduced-motion: reduce) {
  .mock-dot--serving {
    animation: none;
  }
}

.panel__head {
  margin: calc(var(--td-space-4) * -1) calc(var(--td-space-4) * -1) var(--td-space-4);
  padding: var(--td-space-4);
  border-bottom: 1px solid var(--td-border);
}
.panel__note {
  margin: var(--td-space-2) 0 0;
}
.panel__note--bad {
  color: var(--td-danger);
}
.requests {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.request {
  background: var(--td-surface-2);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-md);
}
.request.is-new {
  border-color: var(--td-accent);
}
.request__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--td-space-2);
  padding: var(--td-space-2) var(--td-space-3);
  cursor: pointer;
}
.request__time {
  white-space: nowrap;
}
.request__path {
  flex: 1 1 auto;
  overflow-wrap: anywhere;
}
.request__detail {
  padding: 0 var(--td-space-3) var(--td-space-3);
}
.request__detail p {
  margin: 0 0 var(--td-space-2);
}
.request__label {
  margin-top: var(--td-space-2);
  font-weight: 650;
}
.request__headers {
  margin: 0 0 var(--td-space-1);
}
.request__headers dt {
  display: inline;
  color: var(--td-text-muted);
}
.request__headers dd {
  display: inline;
  margin: 0;
}
.request__warn {
  color: var(--td-warning);
}
</style>
