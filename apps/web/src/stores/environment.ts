import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * The Environment the user is working in. It is chosen once in the top bar and used wherever an
 * Environment is needed (validating a Test, picking target dropdowns, launching Runs), so it does
 * not have to be picked again on every page. Remembered across reloads.
 */
export const useEnvironmentStore = defineStore(
  'environment',
  () => {
    const selectedId = ref('')

    const select = (id: string) => {
      selectedId.value = id
    }

    /** Forget a remembered Environment that no longer exists; adopt the only one if there is one. */
    const reconcile = (ids: readonly string[]) => {
      if (selectedId.value && !ids.includes(selectedId.value)) selectedId.value = ''
      if (!selectedId.value && ids.length === 1) selectedId.value = ids[0] as string
    }

    return { selectedId, select, reconcile }
  },
  { persist: true },
)
