<template>
  <div class="code-editor" :class="{ 'is-invalid': invalid }" :data-testid="testid">
    <!-- Ace owns this element's classes, so no reactive bindings may be placed on it. -->
    <div ref="host" />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ace from 'ace-builds'
import 'ace-builds/src-noconflict/mode-json'
import 'ace-builds/src-noconflict/mode-sql'
import 'ace-builds/src-noconflict/theme-tomorrow'
import 'ace-builds/src-noconflict/theme-tomorrow_night'
import jsonWorkerUrl from 'ace-builds/src-noconflict/worker-json?url'

ace.config.setModuleUrl('ace/mode/json_worker', jsonWorkerUrl)

const props = withDefaults(
  defineProps<{
    modelValue: string
    /** Syntax highlighting; only JSON also gets in-editor validation. */
    language?: 'json' | 'sql'
    id?: string
    minLines?: number
    maxLines?: number
    invalid?: boolean
    describedby?: string
    small?: boolean
    readonly?: boolean
    testid?: string
  }>(),
  { language: 'json', minLines: 4, maxLines: 30 },
)
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const host = ref<HTMLElement>()
let editor: ace.Ace.Editor | undefined
let themeObserver: MutationObserver | undefined
let applyingExternalValue = false

const isDark = () => document.documentElement.getAttribute('data-theme') !== 'light'
const themeName = () => (isDark() ? 'ace/theme/tomorrow_night' : 'ace/theme/tomorrow')

function syncInputAttributes() {
  const input = editor?.textInput.getElement()
  if (!input) return
  if (props.id) input.id = props.id
  // Ace labels its textarea "Cursor at row N", which hides the form's <label for>. Point the
  // textarea at that label so the field keeps the name the page gives it.
  const label = props.id ? document.querySelector<HTMLElement>(`label[for="${props.id}"]`) : null
  if (label) {
    label.id ||= `${props.id}-label`
    input.setAttribute('aria-labelledby', label.id)
  }
  input.setAttribute('aria-invalid', String(Boolean(props.invalid)))
  if (props.describedby) input.setAttribute('aria-describedby', props.describedby)
  else input.removeAttribute('aria-describedby')
}

onMounted(() => {
  if (!host.value) return
  editor = ace.edit(host.value, {
    mode: `ace/mode/${props.language}`,
    theme: themeName(),
    value: props.modelValue,
    minLines: props.minLines,
    maxLines: props.maxLines,
    readOnly: props.readonly,
    tabSize: 2,
    useSoftTabs: true,
    useWorker: props.language === 'json',
    showPrintMargin: false,
    highlightActiveLine: false,
    fontSize: props.small ? 12 : 13,
    wrap: true,
    enableKeyboardAccessibility: true,
  })
  editor.setValue(props.modelValue, -1)
  editor.on('change', () => {
    if (applyingExternalValue) return
    const value = editor!.getValue()
    if (value !== props.modelValue) emit('update:modelValue', value)
  })
  syncInputAttributes()
  themeObserver = new MutationObserver(() => editor?.setTheme(themeName()))
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
})

watch(
  () => props.modelValue,
  (value) => {
    if (!editor || value === editor.getValue()) return
    // Replacing the document fires an intermediate empty change that must not reach the parent.
    applyingExternalValue = true
    try {
      editor.setValue(value, -1)
    } finally {
      applyingExternalValue = false
    }
  },
)
watch(
  () => props.readonly,
  (value) => editor?.setReadOnly(Boolean(value)),
)
watch(() => [props.id, props.invalid, props.describedby], syncInputAttributes)

onBeforeUnmount(() => {
  themeObserver?.disconnect()
  editor?.destroy()
  editor = undefined
})
</script>

<style scoped>
.code-editor {
  width: 100%;
  overflow: hidden;
  background: var(--td-surface-2);
  border: 1px solid var(--td-border-strong);
  border-radius: var(--td-radius-md);
}
.code-editor:focus-within {
  border-color: var(--td-accent);
  box-shadow: 0 0 0 3px var(--td-accent-soft);
}
.code-editor.is-invalid {
  border-color: var(--td-danger);
}
/* Let the editor sit on the app's surface colours. */
.code-editor :deep(.ace_editor),
.code-editor :deep(.ace_gutter) {
  background: transparent;
  font-family: var(--td-font-mono);
}
.code-editor :deep(.ace_gutter) {
  border-right: 1px solid var(--td-border);
}
</style>
