import { defineStore } from 'pinia'
import { ref } from 'vue'

/** Whether the Service Bus Inspector panel is open; any part of the UI may open it. */
export const useInspectorPanel = defineStore('inspector-panel', () => {
  const open = ref(false)
  return { open, show: () => (open.value = true), hide: () => (open.value = false) }
})
