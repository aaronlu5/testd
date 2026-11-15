<template>
  <div class="address" data-testid="mock-api-address">
    <div class="td-row">
      <Icon name="server-2" class="td-muted" />
      <span class="address__title">Mock API server</span>
      <LoadingState v-if="isPending" label="Looking up the address…" />
      <template v-else-if="data">
        <code class="address__url" data-testid="mock-api-url">{{ data.baseUrl }}</code>
        <UiButton size="sm" variant="outline-secondary" @click="copy">{{
          copied ? 'Copied' : 'Copy'
        }}</UiButton>
      </template>
      <span v-else class="address__error td-small">The address is not available.</span>
    </div>
    <p v-if="data" class="td-small td-muted address__text">
      Point the system under test at <code>{{ data.host }}</code> instead of the API that does not
      exist or does not work, and keep the same relative paths. While a Test or Suite that uses a
      setup is running, requests to this address are answered from its rules; otherwise the server
      answers 404.
    </p>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useMockApiInfo } from '~/api/queries'
import LoadingState from '~/components/platform/LoadingState.vue'
import Icon from '~/components/ui/Icon.vue'
import UiButton from '~/components/ui/UiButton.vue'

const { data, isPending } = useMockApiInfo()
const copied = ref(false)

const copy = async () => {
  if (!data.value) return
  try {
    await navigator.clipboard.writeText(data.value.baseUrl)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    /* clipboard unavailable: the address is selectable text */
  }
}
</script>

<style scoped>
.address {
  padding: var(--td-space-4);
  background: var(--td-surface-2);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-md);
}
.address__title {
  font-weight: 650;
}
.address__url {
  font-size: var(--td-text-md);
}
.address__error {
  color: var(--td-danger);
}
.address__text {
  margin: var(--td-space-2) 0 0;
}
</style>
