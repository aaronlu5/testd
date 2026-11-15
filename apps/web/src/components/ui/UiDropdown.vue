<template>
  <div ref="root" class="ui-dropdown" @keydown="onKeydown">
    <UiButton
      :id="triggerId"
      ref="trigger"
      class="ui-dropdown__trigger"
      :variant="variant"
      :size="size"
      :disabled="disabled"
      aria-haspopup="menu"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="menuId"
      :aria-label="label && !$slots.trigger ? undefined : ariaLabel"
      @click="toggle"
    >
      <slot name="trigger" :open="open">
        {{ label }}
        <Icon name="chevron-down" :size="14" />
      </slot>
    </UiButton>
    <div
      v-show="open"
      :id="menuId"
      ref="menu"
      class="ui-dropdown__menu"
      :class="`is-${align}`"
      role="menu"
      :aria-labelledby="triggerId"
    >
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, provide, ref, useId } from 'vue'
import UiButton from './UiButton.vue'
import Icon from './Icon.vue'
import { DROPDOWN_KEY } from './dropdown-context'

withDefaults(
  defineProps<{
    label?: string
    /** Accessible name when the trigger has no visible text (icon-only triggers). */
    ariaLabel?: string
    variant?: 'primary' | 'secondary' | 'ghost' | 'outline-secondary' | 'outline-primary' | 'danger'
    size?: 'sm' | 'md' | 'lg'
    align?: 'start' | 'end'
    disabled?: boolean
  }>(),
  { label: undefined, ariaLabel: undefined, variant: 'secondary', size: 'md', align: 'start' },
)

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const trigger = ref<{ $el: HTMLElement } | null>(null)
const uid = useId()
const triggerId = `dd-trigger-${uid}`
const menuId = `dd-menu-${uid}`

function items(): HTMLElement[] {
  return Array.from(
    menu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ??
      [],
  )
}

async function show(focus: 'first' | 'last' | 'none' = 'first') {
  open.value = true
  await nextTick()
  const list = items()
  if (focus === 'first') list[0]?.focus()
  if (focus === 'last') list[list.length - 1]?.focus()
}

function close(returnFocus = true) {
  if (!open.value) return
  open.value = false
  if (returnFocus) trigger.value?.$el.focus()
}

function toggle() {
  if (open.value) close(false)
  else void show('first')
}

function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement
  const onTrigger = trigger.value?.$el.contains(target)
  if (event.key === 'Escape' && open.value) {
    event.stopPropagation()
    close()
    return
  }
  if (onTrigger && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    void show(event.key === 'ArrowDown' ? 'first' : 'last')
    return
  }
  if (!open.value || onTrigger) return
  const list = items()
  const index = list.indexOf(target)
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    list[(index + 1) % list.length]?.focus()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    list[(index - 1 + list.length) % list.length]?.focus()
  } else if (event.key === 'Home') {
    event.preventDefault()
    list[0]?.focus()
  } else if (event.key === 'End') {
    event.preventDefault()
    list[list.length - 1]?.focus()
  } else if (event.key === 'Tab') {
    close(false)
  }
}

function onDocumentPointer(event: Event) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) close(false)
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointer))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointer))

provide(DROPDOWN_KEY, { close })
defineExpose({ close, open })
</script>

<style scoped>
.ui-dropdown {
  position: relative;
  display: inline-flex;
}
.ui-dropdown__menu {
  position: absolute;
  top: calc(100% + 0.375rem);
  z-index: var(--td-z-dropdown);
  min-width: 12rem;
  max-width: 22rem;
  max-height: 70vh;
  overflow-y: auto;
  padding: var(--td-space-1);
  background: var(--td-surface-2);
  border: 1px solid var(--td-border-strong);
  border-radius: var(--td-radius-md);
  box-shadow: var(--td-shadow-2);
}
.is-start {
  left: 0;
}
.is-end {
  right: 0;
}
</style>
