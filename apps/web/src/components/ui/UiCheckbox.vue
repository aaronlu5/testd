<template>
  <label
    class="ui-check"
    :class="[$attrs.class, { 'is-disabled': disabled }]"
    :style="$attrs.style as never"
  >
    <input
      v-bind="inputAttrs"
      ref="input"
      type="checkbox"
      class="ui-check__input"
      :checked="isChecked"
      :disabled="disabled"
      @change="onChange"
    />
    <span class="ui-check__box" aria-hidden="true"
      ><Icon name="check" :size="12" :stroke-width="3"
    /></span>
    <span v-if="$slots.default" class="ui-check__label"><slot /></span>
  </label>
</template>

<script lang="ts">
export default { inheritAttrs: false }
</script>

<script setup lang="ts">
import { computed, ref, useAttrs, watchEffect } from 'vue'
import Icon from './Icon.vue'

const props = defineProps<{
  /** A boolean, or an array when several checkboxes share one model (with `value`). */
  modelValue?: boolean | unknown[]
  value?: unknown
  disabled?: boolean
  indeterminate?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean | unknown[]] }>()

const isChecked = computed(() =>
  Array.isArray(props.modelValue) ? props.modelValue.includes(props.value) : !!props.modelValue,
)

function onChange(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  if (Array.isArray(props.modelValue)) {
    const without = props.modelValue.filter((item) => item !== props.value)
    emit('update:modelValue', checked ? [...without, props.value] : without)
  } else emit('update:modelValue', checked)
}
const input = ref<HTMLInputElement | null>(null)
const attrs = useAttrs()

// id, data-* and aria-* attributes belong on the real input; class and style on the label.
const inputAttrs = computed(() => {
  const { class: _class, style: _style, ...rest } = attrs
  return rest
})

watchEffect(() => {
  if (input.value) input.value.indeterminate = !!props.indeterminate
})
</script>

<style scoped>
.ui-check {
  position: relative;
  display: inline-flex;
  align-items: flex-start;
  gap: var(--td-space-2);
  font-size: var(--td-text-sm);
  cursor: pointer;
}
.ui-check.is-disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ui-check__input {
  position: absolute;
  opacity: 0;
  width: 1.125rem;
  height: 1.125rem;
  margin: 0;
  cursor: inherit;
}
.ui-check__box {
  flex: none;
  display: grid;
  place-items: center;
  width: 1.125rem;
  height: 1.125rem;
  margin-top: 0.1rem;
  color: transparent;
  background: var(--td-surface-2);
  border: 1px solid var(--td-border-strong);
  border-radius: var(--td-radius-sm);
  transition: background var(--td-dur-fast) var(--td-ease);
}
.ui-check__input:checked + .ui-check__box,
.ui-check__input:indeterminate + .ui-check__box {
  color: var(--td-on-accent);
  background: var(--td-accent);
  border-color: var(--td-accent);
}
.ui-check__input:focus-visible + .ui-check__box {
  outline: 2px solid var(--td-focus);
  outline-offset: 2px;
}
</style>
