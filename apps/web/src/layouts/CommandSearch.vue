<template>
  <UiModal
    :model-value="modelValue"
    title="Jump to a page"
    size="sm"
    @update:model-value="onUpdate"
  >
    <div class="cmd">
      <label class="td-sr-only" for="cmd-input">Search pages</label>
      <input
        id="cmd-input"
        v-model="query"
        class="td-control"
        data-autofocus
        type="search"
        placeholder="Type to filter pages"
        autocomplete="off"
        role="combobox"
        aria-expanded="true"
        aria-controls="cmd-list"
        :aria-activedescendant="results[active] ? `cmd-opt-${results[active]?.slug}` : undefined"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="go(results[active])"
      />
      <ul id="cmd-list" class="cmd__list" role="listbox" aria-label="Pages">
        <li
          v-for="(item, index) in results"
          :id="`cmd-opt-${item.slug}`"
          :key="item.slug"
          role="option"
          class="cmd__option"
          :class="{ 'is-active': index === active }"
          :aria-selected="index === active ? 'true' : 'false'"
          @click="go(item)"
          @mousemove="active = index"
        >
          <Icon :name="item.icon" :size="16" />
          <span>{{ item.label }}</span>
          <span class="td-faint td-small cmd__path">{{ item.to }}</span>
        </li>
        <li v-if="results.length === 0" class="td-muted td-small cmd__empty">No matching pages.</li>
      </ul>
    </div>
  </UiModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '~/components/ui/Icon.vue'
import UiModal from '~/components/ui/UiModal.vue'
import { allNavItems, type NavItem } from './nav'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const router = useRouter()

const query = ref('')
const active = ref(0)

const results = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? allNavItems.filter((i) => i.label.toLowerCase().includes(q)) : allNavItems
})

watch(results, () => {
  active.value = 0
})
watch(
  () => props.modelValue,
  (open) => {
    if (open) query.value = ''
  },
)

function onUpdate(value: boolean) {
  emit('update:modelValue', value)
}
function move(delta: number) {
  const n = results.value.length
  if (n) active.value = (active.value + delta + n) % n
}
function go(item?: NavItem) {
  if (!item) return
  emit('update:modelValue', false)
  void router.push(item.to)
}
</script>

<style scoped>
.cmd {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-3);
}
.cmd__list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 18rem;
  overflow-y: auto;
}
.cmd__option {
  display: flex;
  align-items: center;
  gap: var(--td-space-3);
  padding: 0.5rem var(--td-space-3);
  font-size: var(--td-text-sm);
  border-radius: var(--td-radius-md);
  cursor: pointer;
}
.cmd__option.is-active {
  background: var(--td-accent-soft);
  color: var(--td-accent-text);
}
.cmd__path {
  margin-left: auto;
}
.cmd__empty {
  padding: var(--td-space-3);
}
</style>
