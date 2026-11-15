<template>
  <UiIconButton
    :label="isFullscreen ? 'Exit full screen' : 'Enter full screen'"
    :icon="isFullscreen ? 'minimize' : 'maximize'"
    data-testid="fullscreen-toggle"
    @click="toggle"
  />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'

const isFullscreen = ref(false)

function sync() {
  isFullscreen.value = !!document.fullscreenElement
}

async function toggle() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch {
    // Full screen can be refused by the browser; the button simply stays as it was.
  }
}

onMounted(() => document.addEventListener('fullscreenchange', sync))
onBeforeUnmount(() => document.removeEventListener('fullscreenchange', sync))
</script>
