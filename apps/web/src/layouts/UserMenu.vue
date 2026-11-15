<template>
  <UiDropdown align="end" variant="ghost" aria-label="Account" data-testid="user-menu">
    <template #trigger>
      <span class="avatar" aria-hidden="true"><Icon name="user" :size="16" /></span>
    </template>
    <div class="who">
      <strong>Local user</strong>
      <span class="td-muted td-small">
        Sign-in is not enabled. The platform accepts local connections only.
      </span>
    </div>
    <UiDropdownDivider />
    <UiDropdownItem to="/references"> <Icon name="book" :size="16" /> References </UiDropdownItem>
    <UiDropdownItem to="/system/health">
      <Icon name="heart-rate-monitor" :size="16" /> API status
    </UiDropdownItem>
  </UiDropdown>
</template>

<script setup lang="ts">
import Icon from '~/components/ui/Icon.vue'
import UiDropdown from '~/components/ui/UiDropdown.vue'
import UiDropdownDivider from '~/components/ui/UiDropdownDivider.vue'
import UiDropdownItem from '~/components/ui/UiDropdownItem.vue'
</script>

<style scoped>
.avatar {
  display: grid;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  color: var(--td-on-accent);
  background: var(--td-accent);
  border-radius: 50%;
}
.who {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: var(--td-space-2) var(--td-space-3);
}
</style>
