<template>
  <li class="msg" :class="{ 'msg-new': isNew }" :data-testid="`inspector-message-${message.seq}`">
    <button
      type="button"
      class="msg-head"
      :aria-expanded="expanded"
      :aria-controls="`msg-detail-${message.id}`"
      @click="expanded = !expanded"
    >
      <span class="msg-line">
        <UiBadge :variant="message.origin === 'sent' ? 'info' : 'primary'">
          {{ message.origin === 'sent' ? 'Sent' : 'Received' }}
        </UiBadge>
        <span class="msg-entity td-truncate">{{ messageEntity(message) }}</span>
        <UiBadge v-if="isNew" variant="danger" data-testid="inspector-new-badge">New</UiBadge>
        <time class="msg-time td-muted td-small" :datetime="message.receivedAt">{{ time }}</time>
      </span>
      <span class="msg-sub td-truncate">
        <strong v-if="message.subject">{{ message.subject }}</strong>
        <span v-else-if="message.messageId" class="td-muted">{{ message.messageId }}</span>
      </span>
      <span class="msg-preview td-truncate td-muted td-mono td-small">{{
        message.preview || '(empty body)'
      }}</span>
    </button>

    <div
      v-if="expanded"
      :id="`msg-detail-${message.id}`"
      class="msg-detail"
      data-testid="inspector-detail"
    >
      <LoadingState v-if="isPending" label="Loading message" />
      <div v-else-if="error" class="msg-error td-small" role="alert">
        The message could not be loaded.
      </div>
      <template v-else-if="detail">
        <h4>Body</h4>
        <div class="td-small td-muted">
          {{ detail.bodyEncoding }} · {{ formatBytes(detail.sizeBytes) }}
          <span v-if="detail.bodyTruncated">
            · cut at {{ formatBytes(INSPECTOR_MAX_BODY_BYTES) }}</span
          >
        </div>
        <pre class="msg-body" data-testid="inspector-body">{{ body }}</pre>

        <h4>Metadata</h4>
        <dl class="msg-dl td-small">
          <template v-for="row in rows" :key="row.label">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </template>
          <template v-if="detail.runId">
            <dt>Run</dt>
            <dd>
              <RouterLink :to="`/runs/${detail.runId}`">{{ detail.runId }}</RouterLink>
            </dd>
          </template>
        </dl>

        <h4>Application properties</h4>
        <p v-if="Object.keys(detail.applicationProperties).length === 0" class="td-small td-muted">
          None.
        </p>
        <dl v-else class="msg-dl td-small">
          <template v-for="(value, key) in detail.applicationProperties" :key="key">
            <dt>{{ key }}</dt>
            <dd>{{ typeof value === 'string' ? value : JSON.stringify(value) }}</dd>
          </template>
        </dl>
      </template>
    </div>
  </li>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import { useInspectorMessage } from '~/api/queries'
import type { InspectedMessageSummary } from '~/api/types'
import {
  INSPECTOR_MAX_BODY_BYTES,
  formatBody,
  formatBytes,
  messageEntity,
} from './inspector-format'

const props = defineProps<{ message: InspectedMessageSummary; isNew: boolean }>()

const expanded = ref(false)
const {
  data: detail,
  isPending,
  error,
} = useInspectorMessage(() => (expanded.value ? props.message.id : undefined))

const time = computed(() => new Date(props.message.receivedAt).toLocaleString())
const body = computed(() => (detail.value ? formatBody(detail.value) : ''))

const rows = computed(() => {
  const d = detail.value
  if (!d) return []
  const entries: [string, string | number | undefined][] = [
    ['Origin', d.origin === 'sent' ? 'Sent by a Step' : 'Peeked from the entity'],
    ['Environment / target', `${d.environmentId} / ${d.target}`],
    ['Entity', messageEntity(d)],
    ['Message ID', d.messageId],
    ['Correlation ID', d.correlationId],
    ['Subject', d.subject],
    ['Content type', d.contentType],
    ['Session ID', d.sessionId],
    ['Partition key', d.partitionKey],
    ['To', d.to],
    ['Reply to', d.replyTo],
    ['Sequence number', d.sequenceNumber],
    ['Enqueued', d.enqueuedTime],
    ['Scheduled for', d.scheduledEnqueueTime],
    ['Expires', d.expiresAt],
    ['Time to live (ms)', d.timeToLiveMs],
    ['Delivery count', d.deliveryCount],
    ['Dead-letter reason', d.deadLetterReason],
    ['Collected', d.receivedAt],
    ['Step', d.nodeId],
  ]
  return entries
    .filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== '',
    )
    .map(([label, value]) => ({ label, value }))
})
</script>

<style scoped>
.msg {
  list-style: none;
  border-bottom: 1px solid var(--td-border);
}
.msg-new {
  box-shadow: inset 3px 0 0 var(--td-danger);
}
.msg-head {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  width: 100%;
  padding: var(--td-space-3) var(--td-space-4);
  color: var(--td-text);
  text-align: left;
  background: transparent;
  border: 0;
}
.msg-head:hover,
.msg-head:focus-visible {
  background: var(--td-surface-2);
}
.msg-line {
  display: flex;
  align-items: center;
  gap: var(--td-space-2);
  min-width: 0;
}
.msg-entity {
  font-weight: 650;
}
.msg-time {
  margin-left: auto;
  white-space: nowrap;
}
.msg-detail {
  padding: var(--td-space-1) var(--td-space-4) var(--td-space-4);
}
.msg-detail h4 {
  margin: var(--td-space-4) 0 var(--td-space-1);
  font-size: var(--td-text-sm);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--td-accent-text);
}
.msg-detail h4:first-child {
  margin-top: 0;
}
.msg-error {
  color: var(--td-danger);
}
.msg-body {
  max-height: 20rem;
  margin: var(--td-space-1) 0 0;
  font-size: var(--td-text-xs);
  white-space: pre-wrap;
  word-break: break-word;
}
.msg-dl {
  display: grid;
  grid-template-columns: minmax(7rem, 5fr) 7fr;
  gap: var(--td-space-1) var(--td-space-3);
  margin: 0;
}
.msg-dl dt {
  color: var(--td-text-muted);
  overflow-wrap: anywhere;
}
.msg-dl dd {
  margin: 0;
  font-family: var(--td-font-mono);
  overflow-wrap: anywhere;
}
</style>
