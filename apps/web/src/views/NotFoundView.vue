<template>
  <div class="nf" data-testid="not-found">
    <p class="nf__code" aria-hidden="true">404</p>
    <h1>Page not found</h1>
    <p class="td-muted">
      There is nothing at <code>{{ route.fullPath }}</code
      >.
    </p>
    <UiButton to="/" variant="primary">Back to Home</UiButton>
  </div>
</template>

<script setup lang="ts">
import { useRoute } from 'vue-router'
import UiButton from '~/components/ui/UiButton.vue'

const route = useRoute()
</script>

<style scoped>
.nf {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--td-space-3);
  padding: var(--td-space-8) 0;
  text-align: center;
}
.nf__code {
  margin: 0;
  font-family: var(--td-font-mono);
  font-size: 4rem;
  font-weight: 700;
  line-height: 1;
  color: var(--td-accent);
}
</style>
