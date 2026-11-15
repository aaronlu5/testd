<template>
  <UiDropdown align="end" variant="ghost" aria-label="Theme" data-testid="theme-menu">
    <template #trigger>
      <Icon :name="layout.resolvedTheme === 'dark' ? 'moon' : 'sun'" :size="18" />
    </template>
    <UiDropdownHeader>Theme</UiDropdownHeader>
    <UiDropdownItem
      v-for="option in options"
      :key="option.value"
      :active="layout.theme === option.value"
      :data-testid="`theme-${option.value}`"
      @click="layout.setTheme(option.value)"
    >
      <Icon :name="option.icon" :size="16" />
      {{ option.label }}
      <Icon v-if="layout.theme === option.value" name="check" :size="14" class="theme-check" />
    </UiDropdownItem>
  </UiDropdown>
</template>

<script setup lang="ts">
import Icon from '~/components/ui/Icon.vue'
import UiDropdown from '~/components/ui/UiDropdown.vue'
import UiDropdownHeader from '~/components/ui/UiDropdownHeader.vue'
import UiDropdownItem from '~/components/ui/UiDropdownItem.vue'
import { useLayout, type ThemePreference } from '~/stores/layout'

const layout = useLayout()
const options: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: 'monitor' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
]
</script>

<style scoped>
.theme-check {
  margin-left: auto;
}
</style>
