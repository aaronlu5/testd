<template>
  <fieldset class="ref" :data-testid="`secret-ref-${testId}`">
    <legend class="ref__legend">{{ label }}</legend>
    <div class="ref__grid">
      <div class="td-field">
        <label :for="`${id}-provider`" class="td-hint">Source</label>
        <select
          :id="`${id}-provider`"
          class="td-control td-control--sm"
          :value="provider"
          @change="setProvider(($event.target as HTMLSelectElement).value)"
        >
          <option value="">{{ noneLabel }}</option>
          <option value="keyVault">Azure Key Vault</option>
          <option
            value="localPlainText"
            :disabled="!allowPlainText && provider !== 'localPlainText'"
          >
            Local plain text
          </option>
        </select>
      </div>
      <template v-if="modelValue">
        <div class="td-field">
          <label :for="`${id}-name`" class="td-hint">
            {{ modelValue.provider === 'keyVault' ? 'Secret name or URI' : 'Secret name' }}
          </label>
          <input
            :id="`${id}-name`"
            class="td-control td-control--sm"
            :value="modelValue.name"
            :list="`${id}-known`"
            autocomplete="off"
            spellcheck="false"
            :placeholder="
              modelValue.provider === 'keyVault'
                ? 'orders-api-key or https://vault/secrets/name'
                : 'orders-api-key'
            "
            @input="patch({ name: ($event.target as HTMLInputElement).value })"
          />
          <datalist :id="`${id}-known`">
            <option v-for="name in knownLocalNames" :key="name" :value="name" />
          </datalist>
        </div>
        <div class="td-field">
          <label :for="`${id}-usage`" class="td-hint">Used as</label>
          <select
            :id="`${id}-usage`"
            class="td-control td-control--sm"
            :value="modelValue.usage ?? ''"
            @change="setUsage(($event.target as HTMLSelectElement).value)"
          >
            <option value="">Default</option>
            <option v-for="usage in usages" :key="usage" :value="usage">
              {{ usageLabel(usage) }}
            </option>
          </select>
        </div>
      </template>
    </div>

    <p v-if="blockedPlainText" class="ref__note ref__note--bad td-small" role="alert">
      This Environment's classification requires Key Vault; switch the source to Azure Key Vault.
    </p>
    <p
      v-else-if="modelValue?.provider === 'localPlainText' && modelValue.name"
      class="ref__note td-small"
    >
      <template v-if="localStatus === 'missing'">
        <UiBadge variant="warning">Not set</UiBadge>
        No value exists for this name yet.
      </template>
      <template v-else-if="localStatus === 'set'">
        <UiBadge variant="success">Set</UiBadge>
      </template>
      <RouterLink to="/secrets">Manage local secrets</RouterLink>
    </p>
    <p v-else-if="modelValue?.provider === 'keyVault'" class="ref__note td-small td-muted">
      Only the reference is stored here; the value stays in Key Vault.
    </p>
  </fieldset>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import type { SecretReference, SecretUsage } from '~/api/types'

const props = withDefaults(
  defineProps<{
    modelValue?: SecretReference
    label: string
    testId: string
    usages: SecretUsage[]
    allowPlainText: boolean
    knownLocalNames?: string[]
    /** `set` / `missing` for the referenced local name, when known. */
    localStatus?: 'set' | 'missing'
    noneLabel?: string
  }>(),
  { knownLocalNames: () => [], noneLabel: 'None' },
)
const emit = defineEmits<{ 'update:modelValue': [value: SecretReference | undefined] }>()

const id = `ref-${useId()}`
const provider = computed(() => props.modelValue?.provider ?? '')
const blockedPlainText = computed(
  () => !props.allowPlainText && props.modelValue?.provider === 'localPlainText',
)

const USAGE_LABELS: Record<string, string> = {
  connectionString: 'Connection string',
  apiKey: 'API key',
  bearerToken: 'Bearer token',
  password: 'Password',
}
const usageLabel = (usage: string) => USAGE_LABELS[usage] ?? usage

const setProvider = (value: string) => {
  if (value === '') return emit('update:modelValue', undefined)
  emit('update:modelValue', {
    type: 'secretReference',
    provider: value as SecretReference['provider'],
    // Keep what was typed when switching source; the name often stays the same.
    name: props.modelValue?.name ?? '',
    ...(props.modelValue?.usage ? { usage: props.modelValue.usage } : {}),
  })
}
const patch = (change: Partial<SecretReference>) => {
  if (props.modelValue) emit('update:modelValue', { ...props.modelValue, ...change })
}
const setUsage = (value: string) => {
  if (!props.modelValue) return
  const { usage: _drop, ...rest } = props.modelValue
  void _drop
  emit('update:modelValue', value ? { ...rest, usage: value as SecretUsage } : rest)
}
</script>

<style scoped>
.ref {
  min-width: 0;
  margin: 0;
  padding: var(--td-space-3);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-md);
}
.ref__legend {
  padding: 0 var(--td-space-1);
  font-size: var(--td-text-sm);
  font-weight: 650;
}
.ref__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--td-space-3);
}
.ref__note {
  margin: var(--td-space-2) 0 0;
}
.ref__note--bad {
  color: var(--td-danger);
}
</style>
