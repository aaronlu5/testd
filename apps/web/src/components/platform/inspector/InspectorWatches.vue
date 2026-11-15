<template>
  <div class="watches" data-testid="inspector-watches">
    <p class="td-small td-muted">
      The inspector only <strong>peeks</strong>: it never receives, completes or deletes a message,
      so it cannot take one from the real consumer. A message that is consumed before the next check
      is not seen by peeking; for a topic, watch a subscription dedicated to inspection. A Service
      Bus Step with <em>inspect</em> turned on also records a copy of what it sends.
    </p>

    <ul v-if="watches.length > 0" class="watch-list">
      <li
        v-for="watch in watches"
        :key="watch.id"
        class="watch"
        :data-testid="`inspector-watch-${watch.id}`"
      >
        <div class="watch__body">
          <div class="watch__label">{{ watchLabel(watch) }}</div>
          <div class="td-small td-muted">
            {{ watch.environmentId }} ·
            {{ watch.source === 'step' ? 'added by a Step' : 'added manually' }} ·
            {{ watch.receivedCount }} collected
          </div>
          <div class="td-small" :class="{ watch__bad: watchStatus(watch).kind === 'error' }">
            <UiBadge :variant="statusVariant(watch)">{{
              watchStatus(watch).kind === 'error'
                ? 'Error'
                : watchStatus(watch).kind === 'ok'
                  ? 'OK'
                  : 'Waiting'
            }}</UiBadge>
            {{ watchStatus(watch).text }}
          </div>
        </div>
        <UiIconButton
          size="sm"
          variant="outline-secondary"
          icon="x"
          :label="`Stop watching ${watchLabel(watch)}`"
          @click="emit('remove', watch.id)"
        />
      </li>
    </ul>
    <p v-else class="td-small td-muted" data-testid="inspector-no-watches">
      Nothing is being watched yet.
    </p>

    <form class="add" data-testid="inspector-add-form" @submit.prevent="submit">
      <h4>Watch a queue or topic</h4>
      <p v-if="choices.length === 0" class="td-small td-muted" data-testid="inspector-no-targets">
        No Service Bus target allows inspection. Add <code>"inspect"</code> to the target's
        <code>allowedOperations</code> in the Environment configuration.
      </p>
      <div v-else class="td-stack" style="--td-gap: var(--td-space-3)">
        <div class="td-field">
          <label for="inspector-target" class="td-label">Environment and target</label>
          <select id="inspector-target" v-model="choiceKey" class="td-control td-control--sm">
            <option v-for="choice in choices" :key="choice.key" :value="choice.key">
              {{ choice.environmentName }} / {{ choice.target }}
            </option>
          </select>
        </div>
        <div class="td-field">
          <label for="inspector-entity" class="td-label">Queue or topic</label>
          <select id="inspector-entity" v-model="entity" class="td-control td-control--sm">
            <option v-for="name in selected?.entities ?? []" :key="name" :value="name">
              {{ name }}
            </option>
          </select>
        </div>
        <div class="td-field">
          <label for="inspector-subscription" class="td-label">Subscription (topics only)</label>
          <input
            id="inspector-subscription"
            v-model.trim="subscription"
            class="td-control td-control--sm"
            maxlength="50"
            autocomplete="off"
            placeholder="Leave empty for a queue"
          />
        </div>
        <ProblemAlert v-if="addError" :error="addError" />
        <div>
          <UiButton
            type="submit"
            size="sm"
            variant="primary"
            :disabled="adding || !selected || !entity"
          >
            Start watching
          </UiButton>
        </div>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch as watchEffect } from 'vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import type { EnvironmentSummary, InspectorWatch, InspectorWatchInput } from '~/api/types'
import { watchLabel, watchStatus } from './inspector-format'

const props = defineProps<{
  watches: InspectorWatch[]
  environments: EnvironmentSummary[]
  adding: boolean
  addError?: unknown
}>()
const emit = defineEmits<{
  add: [input: InspectorWatchInput]
  remove: [id: string]
}>()

/** Service Bus targets that explicitly allow inspection. */
const choices = computed(() =>
  props.environments.flatMap((environment) =>
    environment.targets
      .filter((target) => target.serviceBus?.canInspect)
      .map((target) => ({
        key: `${environment.id}\u0000${target.name}`,
        environmentId: environment.id,
        environmentName: environment.name,
        target: target.name,
        entities: target.serviceBus?.entities ?? [],
      })),
  ),
)

const choiceKey = ref('')
const entity = ref('')
const subscription = ref('')
const selected = computed(() => choices.value.find((choice) => choice.key === choiceKey.value))

watchEffect(
  choices,
  (list) => {
    if (!list.some((choice) => choice.key === choiceKey.value)) choiceKey.value = list[0]?.key ?? ''
  },
  { immediate: true },
)
watchEffect(
  selected,
  (choice) => {
    if (!choice?.entities.includes(entity.value)) entity.value = choice?.entities[0] ?? ''
  },
  { immediate: true },
)

const statusVariant = (item: InspectorWatch) =>
  ({ error: 'danger', ok: 'success', waiting: 'neutral' })[watchStatus(item).kind] as
    | 'danger'
    | 'success'
    | 'neutral'

const submit = () => {
  if (!selected.value || !entity.value) return
  emit('add', {
    environmentId: selected.value.environmentId,
    target: selected.value.target,
    entity: entity.value,
    ...(subscription.value ? { subscription: subscription.value } : {}),
  })
}
</script>

<style scoped>
.watch-list {
  margin: 0 0 var(--td-space-4);
  padding: 0;
  list-style: none;
}
.watch {
  display: flex;
  align-items: flex-start;
  gap: var(--td-space-2);
  padding: var(--td-space-2) 0;
  border-bottom: 1px solid var(--td-border);
}
.watch__body {
  flex: 1 1 auto;
  min-width: 0;
}
.watch__label {
  font-weight: 650;
  overflow-wrap: anywhere;
}
.watch__bad {
  color: var(--td-danger);
}
.add {
  padding: var(--td-space-4);
  background: var(--td-surface);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-md);
}
.add h4 {
  margin: 0 0 var(--td-space-2);
  font-size: var(--td-text-sm);
}
</style>
