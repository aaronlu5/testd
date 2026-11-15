<template>
  <TopbarToggle
    id="service-bus-inspector-toggler"
    :label="
      unread > 0
        ? `Service Bus Inspector, ${unread} new message${unread === 1 ? '' : 's'}`
        : 'Service Bus Inspector'
    "
    title="Service Bus Inspector"
    data-testid="inspector-toggle"
    @click="panel.show()"
  >
    <Icon name="inbox" :size="20" />
    <template #overlay>
      <span v-if="unread > 0" class="sb-badge" data-testid="inspector-badge">{{
        badgeText(unread)
      }}</span>
    </template>
  </TopbarToggle>

  <UiDrawer
    v-model="panel.open"
    title="Service Bus Inspector"
    size="lg"
    data-testid="inspector-panel"
  >
    <div class="sb-head">
      <div class="td-row">
        <UiButton
          size="sm"
          variant="outline-secondary"
          :aria-expanded="showWatches"
          data-testid="inspector-watches-toggle"
          @click="showWatches = !showWatches"
        >
          <Icon name="list-details" :size="14" />
          Watching {{ summary?.watches.length ?? 0 }}
        </UiButton>
        <span class="td-small td-muted" data-testid="inspector-count">
          {{ summary?.total ?? 0 }} message{{ summary?.total === 1 ? '' : 's' }}
        </span>
        <div class="td-spacer"></div>
        <template v-if="confirmingClear">
          <UiButton
            size="sm"
            variant="danger"
            :disabled="clearing"
            data-testid="inspector-clear-confirm"
            @click="clear"
            >Delete all {{ summary?.total ?? 0 }}</UiButton
          >
          <UiButton size="sm" variant="outline-secondary" @click="confirmingClear = false"
            >Keep</UiButton
          >
        </template>
        <UiButton
          v-else
          size="sm"
          variant="outline-danger"
          :disabled="!summary?.total"
          data-testid="inspector-clear"
          @click="confirmingClear = true"
        >
          <Icon name="trash" :size="14" />Clear
        </UiButton>
      </div>
      <p v-if="summary && summary.total >= summary.maxMessages" class="sb-full td-small">
        The store is full ({{ summary.maxMessages }} messages); the oldest are dropped as new ones
        arrive.
      </p>
    </div>

    <div v-if="showWatches" class="sb-watches">
      <InspectorWatches
        :watches="summary?.watches ?? []"
        :environments="environments ?? []"
        :adding="mutations.addWatch.isPending.value"
        :add-error="mutations.addWatch.error.value"
        @add="(input) => mutations.addWatch.mutate(input)"
        @remove="(id) => mutations.removeWatch.mutate(id)"
      />
    </div>

    <ProblemAlert v-if="loadError" :error="loadError" />
    <LoadingState v-else-if="loadingMessages" label="Loading messages" />
    <div v-else-if="items.length === 0" class="sb-empty" data-testid="inspector-empty">
      <p>No messages yet.</p>
      <p class="td-small td-muted">
        Turn on <em>inspect</em> in a Service Bus send Step, or add a queue or topic to watch.
      </p>
    </div>
    <ul v-else class="sb-list" data-testid="inspector-messages">
      <InspectorMessageItem
        v-for="message in items"
        :key="message.id"
        :message="message"
        :is-new="isNewMessage(message.seq, highlightAfter)"
      />
    </ul>
    <div v-if="hasMore" class="sb-more">
      <UiButton
        size="sm"
        variant="outline-secondary"
        data-testid="inspector-more"
        @click="limit += 100"
        >Load older messages</UiButton
      >
    </div>
  </UiDrawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import TopbarToggle from '~/components/platform/TopbarToggle.vue'
import Icon from '~/components/ui/Icon.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiDrawer from '~/components/ui/UiDrawer.vue'
import {
  useEnvironments,
  useInspectorMessages,
  useInspectorMutations,
  useInspectorSummary,
} from '~/api/queries'
import { useInspectorPanel } from '~/stores/inspector'
import InspectorMessageItem from './InspectorMessageItem.vue'
import InspectorWatches from './InspectorWatches.vue'
import { badgeText, isNewMessage } from './inspector-format'

const panel = useInspectorPanel()
const mutations = useInspectorMutations()

// The badge is polled slowly in the background and quickly while the panel is open.
const { data: summary } = useInspectorSummary(() => (panel.open ? 2000 : 4000))
const { data: environments } = useEnvironments()

const unread = computed(() => summary.value?.unread ?? 0)
const showWatches = ref(false)
const confirmingClear = ref(false)
const clearing = computed(() => mutations.clear.isPending.value)
const limit = ref(100)

const {
  data: page,
  isPending: loadingMessages,
  error: loadError,
} = useInspectorMessages(limit, () => panel.open)
const items = computed(() => page.value?.items ?? [])
const hasMore = computed(() => (page.value?.total ?? 0) > items.value.length)

/**
 * Messages up to this position were already seen before the panel opened; everything after is
 * flagged "New" until it closes, even though opening the panel clears the badge.
 */
const highlightAfter = ref(0)

watch(
  () => panel.open,
  (open) => {
    confirmingClear.value = false
    if (open) {
      highlightAfter.value = summary.value?.lastViewedSeq ?? 0
      limit.value = 100
    }
  },
)

// While the panel is open, everything it shows counts as seen.
watch(
  () => [panel.open, summary.value?.lastSeq, summary.value?.lastViewedSeq] as const,
  ([open, lastSeq, lastViewed]) => {
    if (open && lastSeq !== undefined && lastViewed !== undefined && lastSeq > lastViewed) {
      mutations.markViewed.mutate(lastSeq)
    }
  },
  { immediate: true },
)

const clear = () => {
  mutations.clear.mutate(undefined, {
    onSuccess: () => {
      confirmingClear.value = false
      highlightAfter.value = 0
    },
  })
}
</script>

<style scoped>
.sb-badge {
  position: absolute;
  top: -0.125rem;
  right: -0.25rem;
  min-width: 1.125rem;
  padding: 0 0.25rem;
  font-size: 0.625rem;
  font-weight: 700;
  line-height: 1.125rem;
  text-align: center;
  color: #fff;
  background: var(--td-danger);
  border-radius: var(--td-radius-pill);
}
.sb-head,
.sb-watches {
  margin: 0 calc(var(--td-space-4) * -1);
  padding: var(--td-space-4);
  border-bottom: 1px solid var(--td-border);
}
.sb-head {
  margin-top: calc(var(--td-space-4) * -1);
}
.sb-watches {
  background: var(--td-surface-2);
  margin-bottom: var(--td-space-4);
}
.sb-full {
  margin: var(--td-space-2) 0 0;
  color: var(--td-warning);
}
.sb-empty {
  padding: var(--td-space-6) var(--td-space-4);
  text-align: center;
}
.sb-empty p {
  margin: 0 0 var(--td-space-1);
}
.sb-list {
  margin: 0 calc(var(--td-space-4) * -1);
  padding: 0;
}
.sb-more {
  padding: var(--td-space-4);
  text-align: center;
}
</style>
