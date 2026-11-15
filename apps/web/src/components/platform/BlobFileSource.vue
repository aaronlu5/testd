<template>
  <div class="td-field blob" data-testid="blob-content-source">
    <div class="td-label">Content source<span class="blob__req" aria-hidden="true"> *</span></div>
    <div class="blob__modes">
      <label class="blob__radio" :for="`${idPrefix}-source-text`">
        <input
          :id="`${idPrefix}-source-text`"
          type="radio"
          :name="`${idPrefix}-source`"
          :checked="mode === 'text'"
          @change="emit('mode', 'text')"
        />
        Text or JSON
      </label>
      <label class="blob__radio" :for="`${idPrefix}-source-file`">
        <input
          :id="`${idPrefix}-source-file`"
          type="radio"
          :name="`${idPrefix}-source`"
          :checked="mode === 'file'"
          data-testid="source-file"
          @change="emit('mode', 'file')"
        />
        Files
      </label>
    </div>

    <template v-if="mode === 'file'">
      <input
        :id="`${idPrefix}-file`"
        class="td-control blob__input"
        type="file"
        multiple
        data-testid="blob-file-input"
        :aria-invalid="Boolean(error)"
        @change="onFiles"
      />
      <ul v-if="files.length > 0" class="blob__files td-small" data-testid="blob-files">
        <li v-for="file in files" :key="file.name">
          <span class="td-truncate">{{ file.name }}</span>
          <span class="td-muted blob__size">{{ formatBytes(sizeOf(file)) }}</span>
          <button
            type="button"
            class="blob__remove"
            :aria-label="`Remove ${file.name}`"
            @click="remove(file.name)"
          >
            ×
          </button>
        </li>
      </ul>
      <div class="td-hint">
        Each file becomes a blob named after it. Files are saved inside the Test, so together they
        are limited to {{ formatBytes(MAX_TOTAL_BYTES) }}. Masked in logs and run records.
      </div>
      <div v-if="files.length === 0 && !error" class="td-hint">Choose at least one file.</div>
    </template>
    <div v-if="error" class="td-error" role="alert">{{ error }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

export type UploadFile = { name: string; content: string; contentType?: string }

/** Base64 grows files by a third and the API body limit is 1 MiB, so keep well under it. */
const MAX_TOTAL_BYTES = 700 * 1024
const MAX_FILES = 20

const props = defineProps<{
  mode: 'text' | 'file'
  /** The files stored in the step, as base64. */
  files: UploadFile[]
  idPrefix: string
  /** Validation message for the files parameter. */
  serverError?: string
}>()

const emit = defineEmits<{
  mode: ['text' | 'file']
  files: [files: UploadFile[]]
}>()

const readError = ref<string>()
const error = computed(() => readError.value ?? props.serverError)

const sizeOf = (file: UploadFile): number => {
  const padding = /=*$/.exec(file.content)?.[0].length ?? 0
  return Math.floor((file.content.length * 3) / 4) - padding
}

const formatBytes = (bytes: number): string =>
  bytes >= 1024 ? `${(bytes / 1024).toFixed(bytes >= 10240 ? 0 : 1)} KiB` : `${bytes} bytes`

const read = (file: File): Promise<UploadFile> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`))
    reader.onload = () => {
      const result = String(reader.result)
      resolve({
        name: file.name,
        content: result.slice(result.indexOf(',') + 1),
        ...(file.type ? { contentType: file.type } : {}),
      })
    }
    reader.readAsDataURL(file)
  })

const remove = (name: string) =>
  emit(
    'files',
    props.files.filter((file) => file.name !== name),
  )

const onFiles = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const picked = Array.from(input.files ?? [])
  input.value = ''
  if (picked.length === 0) return
  readError.value = undefined
  try {
    const loaded = await Promise.all(picked.map(read))
    // A file picked again replaces the one with the same name.
    const next = [...props.files.filter((file) => !loaded.some((item) => item.name === file.name))]
    next.push(...loaded)
    const total = next.reduce((sum, file) => sum + sizeOf(file), 0)
    if (next.length > MAX_FILES) {
      readError.value = `A Step uploads at most ${MAX_FILES} files.`
      return
    }
    if (total > MAX_TOTAL_BYTES) {
      readError.value = `Those files add up to ${formatBytes(total)}; the limit is ${formatBytes(MAX_TOTAL_BYTES)}.`
      return
    }
    emit('files', next)
  } catch (failure) {
    readError.value = failure instanceof Error ? failure.message : 'A file could not be read.'
  }
}
</script>

<style scoped>
.blob__req {
  color: var(--td-danger);
}
.blob__modes {
  display: flex;
  gap: var(--td-space-4);
}
.blob__radio {
  display: inline-flex;
  align-items: center;
  gap: var(--td-space-2);
  font-size: var(--td-text-sm);
  cursor: pointer;
}
.blob__radio input {
  accent-color: var(--td-accent);
}
.blob__files {
  margin: var(--td-space-2) 0 0;
  padding: 0;
  list-style: none;
}
.blob__files li {
  display: flex;
  align-items: center;
  gap: var(--td-space-2);
  padding: var(--td-space-1) 0;
  border-bottom: 1px solid var(--td-border);
}
.blob__size {
  margin-left: auto;
  white-space: nowrap;
}
.blob__remove {
  padding: 0 var(--td-space-2);
  color: var(--td-text-muted);
  background: transparent;
  border: 1px solid var(--td-border-strong);
  border-radius: var(--td-radius-sm);
}
.blob__remove:hover {
  color: var(--td-text);
  background: var(--td-surface-3);
}
</style>
