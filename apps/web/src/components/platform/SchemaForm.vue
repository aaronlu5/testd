<template>
  <div class="schema-form" data-testid="schema-form">
    <UiAlert v-for="message in formErrors" :key="message" variant="warning">
      {{ message }}
    </UiAlert>

    <p v-if="fields.length === 0" class="td-muted td-small td-mb-0">
      This Step has no parameters to configure.
    </p>

    <div
      v-for="field in visibleFields"
      :key="field.key"
      class="td-field"
      :data-testid="`field-${field.key}`"
    >
      <slot :name="`before-${field.key}`" />
      <template v-if="field.kind === 'boolean' && !field.sensitive">
        <UiCheckbox
          :id="controlId(field)"
          class="schema-form__check"
          :model-value="modelValue[field.key] === true"
          :aria-describedby="describedBy(field)"
          @update:model-value="setBoolean(field, $event as boolean)"
        >
          <span class="td-label">{{ field.label }}</span>
        </UiCheckbox>
      </template>
      <template v-else>
        <label class="td-label" :for="controlId(field)">
          {{ field.label
          }}<span v-if="field.required" class="schema-form__req" aria-hidden="true"> *</span>
          <span v-if="field.required" class="td-sr-only"> (required)</span>
        </label>

        <template v-if="field.sensitive">
          <input
            :id="controlId(field)"
            class="td-control"
            type="password"
            disabled
            autocomplete="off"
            value=""
            placeholder="Managed outside the Test"
            :aria-describedby="describedBy(field)"
          />
          <div :id="`${controlId(field)}-secret`" class="td-hint">
            Secrets are never entered here. Reference a configured Environment target instead.
          </div>
        </template>
        <select
          v-else-if="isTargetPicker(field)"
          :id="controlId(field)"
          class="td-control"
          :value="drafts[field.key]"
          :aria-invalid="Boolean(errorFor(field))"
          :aria-describedby="describedBy(field)"
          @change="onInput(field, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">(select a target)</option>
          <option v-if="unknownTarget(field)" :value="drafts[field.key]">
            {{ drafts[field.key] }} (not in this Environment)
          </option>
          <option v-for="target in targetOptions" :key="target.name" :value="target.name">
            {{ target.name }}
          </option>
        </select>
        <select
          v-else-if="field.kind === 'enum'"
          :id="controlId(field)"
          class="td-control"
          :value="drafts[field.key]"
          :aria-invalid="Boolean(errorFor(field))"
          :aria-describedby="describedBy(field)"
          @change="onInput(field, ($event.target as HTMLSelectElement).value)"
        >
          <option v-if="!field.required" value="">(not set)</option>
          <option v-for="option in field.options" :key="String(option)" :value="String(option)">
            {{ option }}
          </option>
        </select>
        <CodeEditor
          v-else-if="field.kind === 'json' || codeLanguages[field.key]"
          :id="controlId(field)"
          :model-value="drafts[field.key] ?? ''"
          :language="codeLanguages[field.key] ?? 'json'"
          :min-lines="codeLanguages[field.key] ? 5 : 3"
          :invalid="Boolean(errorFor(field))"
          :describedby="describedBy(field)"
          @update:model-value="onInput(field, $event)"
        />
        <input
          v-else
          :id="controlId(field)"
          class="td-control"
          type="text"
          autocomplete="off"
          :inputmode="field.kind === 'string' ? undefined : 'decimal'"
          :maxlength="field.maxLength"
          :disabled="disabledKeys.includes(field.key)"
          :placeholder="disabledKeys.includes(field.key) ? disabledPlaceholder : undefined"
          :value="drafts[field.key]"
          :aria-invalid="Boolean(errorFor(field))"
          :aria-describedby="describedBy(field)"
          @input="onInput(field, ($event.target as HTMLInputElement).value)"
        />
      </template>

      <div v-if="field.kind === 'json' && !field.sensitive" class="td-hint">
        JSON, or text that may contain <code v-pre>{{ expressions }}</code
        >. Quote a value (<code>"5"</code>) to keep it as text.
      </div>
      <div v-if="isTargetPicker(field) && targetOptions?.length === 0" class="td-hint">
        The selected Environment has no targets of this kind.
        <RouterLink to="/environments">Add one</RouterLink>.
      </div>
      <div v-else-if="field.key === 'target' && !targetOptions" class="td-hint">
        Choose an Environment above to pick from its targets.
      </div>
      <div v-if="field.redacted" class="td-hint">Masked in logs and run records.</div>
      <div v-if="field.description" :id="`${controlId(field)}-help`" class="td-hint">
        {{ field.description }}
      </div>
      <div v-if="errorFor(field)" :id="`${controlId(field)}-error`" class="td-error" role="alert">
        {{ errorFor(field) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue'
import type { JsonObject } from '~/api/types'
import CodeEditor from '~/components/platform/CodeEditor.vue'
import UiAlert from '~/components/ui/UiAlert.vue'
import UiCheckbox from '~/components/ui/UiCheckbox.vue'
import { formatForInput, parseInput, type FieldDefinition } from '~/components/platform/schema-form'

const props = withDefaults(
  defineProps<{
    fields: FieldDefinition[]
    modelValue: JsonObject
    /** Field key to message, from client or server validation. */
    errors?: Record<string, string>
    formErrors?: string[]
    idPrefix?: string
    /**
     * Targets of the selected Environment that fit this Step, for the `target` field. Without it
     * (no Environment chosen) the field stays a free-text box.
     */
    targetOptions?: { name: string }[]
    /** Fields another control on the page takes care of. */
    hiddenKeys?: string[]
    /** Fields shown but not editable, with the text to show in them. */
    disabledKeys?: string[]
    disabledPlaceholder?: string
    /** Text fields edited in a syntax-highlighting code editor, by field key. */
    codeLanguages?: Record<string, 'sql'>
  }>(),
  {
    errors: () => ({}),
    formErrors: () => [],
    idPrefix: 'param',
    targetOptions: undefined,
    hiddenKeys: () => [],
    disabledKeys: () => [],
    disabledPlaceholder: undefined,
    codeLanguages: () => ({}),
  },
)

const emit = defineEmits<{ 'update:modelValue': [value: JsonObject] }>()

// Raw control text is kept per field so typing never reformats under the cursor. The parent
// re-keys the form when a different Step is selected.
const drafts = reactive<Record<string, string>>({})
const parseErrors = reactive<Record<string, string>>({})
for (const field of props.fields) {
  drafts[field.key] = field.sensitive ? '' : formatForInput(props.modelValue[field.key], field)
}

const visibleFields = computed(() =>
  props.fields.filter((field) => !props.hiddenKeys.includes(field.key)),
)
const isTargetPicker = (field: FieldDefinition) =>
  field.key === 'target' && field.kind === 'string' && props.targetOptions !== undefined
const unknownTarget = (field: FieldDefinition) => {
  const current = drafts[field.key]
  return Boolean(current) && !props.targetOptions?.some((target) => target.name === current)
}

const controlId = (field: FieldDefinition) => `${props.idPrefix}-${field.key}`
const errorFor = (field: FieldDefinition): string | undefined =>
  parseErrors[field.key] ?? props.errors[field.key]
const describedBy = (field: FieldDefinition): string | undefined => {
  const ids = [
    field.description ? `${controlId(field)}-help` : '',
    errorFor(field) ? `${controlId(field)}-error` : '',
    field.sensitive ? `${controlId(field)}-secret` : '',
  ].filter(Boolean)
  return ids.length > 0 ? ids.join(' ') : undefined
}

const commit = (field: FieldDefinition, value: JsonObject[string] | undefined) => {
  const next = { ...props.modelValue }
  if (value === undefined) delete next[field.key]
  else next[field.key] = value
  emit('update:modelValue', next)
}

const onInput = (field: FieldDefinition, text: string) => {
  drafts[field.key] = text
  const parsed = parseInput(text, field)
  if ('error' in parsed) {
    parseErrors[field.key] = parsed.error
    return
  }
  delete parseErrors[field.key]
  commit(field, 'omit' in parsed ? undefined : parsed.value)
}

const setBoolean = (field: FieldDefinition, checked: boolean) => commit(field, checked)
</script>

<style scoped>
.schema-form {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-4);
}
.schema-form__req {
  color: var(--td-danger);
}
</style>
