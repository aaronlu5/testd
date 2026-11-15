<template>
  <div class="empty" data-testid="empty-state">
    <span class="empty__icon" aria-hidden="true"><Icon name="inbox" :size="22" /></span>
    <div class="empty__title">{{ title }}</div>
    <p v-if="description" class="empty__text">{{ description }}</p>
    <slot />
  </div>
</template>

<script setup lang="ts">
import Icon from '~/components/ui/Icon.vue'

defineProps<{ title: string; description?: string }>()
</script>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--td-space-2);
  padding: var(--td-space-7) var(--td-space-4);
  text-align: center;
  color: var(--td-text-muted);
}
.empty__icon {
  display: grid;
  place-items: center;
  width: 3rem;
  height: 3rem;
  margin-bottom: var(--td-space-1);
  color: var(--td-accent-text);
  background: var(--td-accent-soft);
  border-radius: var(--td-radius-lg);
}
.empty__title {
  font-weight: 650;
  color: var(--td-text);
}
.empty__text {
  max-width: 28rem;
  margin: 0 0 var(--td-space-2);
}
</style>
