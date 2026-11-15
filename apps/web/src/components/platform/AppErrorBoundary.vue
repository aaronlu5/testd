<template>
  <slot v-if="!error" />
  <div v-else class="boundary" role="alert" data-testid="app-error">
    <UiCard class="boundary__card">
      <div class="boundary__mark" aria-hidden="true">!</div>
      <h2>Something went wrong</h2>
      <p class="td-muted">
        The application hit an unexpected error. You can retry, or reload the page.
      </p>
      <p class="td-muted td-small boundary__message">{{ error.message }}</p>
      <div class="td-row boundary__actions">
        <UiButton variant="primary" @click="reset">Try again</UiButton>
        <UiButton variant="outline-secondary" @click="reload">Reload</UiButton>
      </div>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
import { onErrorCaptured, ref } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'

const error = ref<Error | null>(null)

onErrorCaptured((err) => {
  error.value = err instanceof Error ? err : new Error(String(err))
  return false
})

const reset = () => {
  error.value = null
}
const reload = () => window.location.reload()
</script>

<style scoped>
.boundary {
  padding: var(--td-space-8) var(--td-space-4);
}
.boundary__card {
  max-width: 36rem;
  margin: 0 auto;
  text-align: center;
}
.boundary__mark {
  display: inline-grid;
  place-items: center;
  width: 3rem;
  height: 3rem;
  margin-bottom: var(--td-space-3);
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--td-danger);
  background: color-mix(in srgb, var(--td-danger) 14%, transparent);
  border-radius: 50%;
}
.boundary__message {
  overflow-wrap: anywhere;
}
.boundary__actions {
  justify-content: center;
}
</style>
