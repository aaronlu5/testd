import 'pinia-plugin-persistedstate'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export type ThemePreference = 'system' | 'light' | 'dark'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Shell state: theme preference and side-menu state. Persisted under `td-layout`. */
export const useLayout = defineStore(
  'layout',
  () => {
    const theme = ref<ThemePreference>('system')
    const navCollapsed = ref(false)
    const mobileNavOpen = ref(false)
    const systemDark = ref(typeof matchMedia === 'function' ? matchMedia(DARK_QUERY).matches : true)

    const resolvedTheme = computed<'light' | 'dark'>(() =>
      theme.value === 'system' ? (systemDark.value ? 'dark' : 'light') : theme.value,
    )

    function applyTheme() {
      document.documentElement.setAttribute('data-theme', resolvedTheme.value)
    }

    function setTheme(next: ThemePreference) {
      theme.value = next
      applyTheme()
    }

    /** Apply the stored theme and follow OS changes while the preference is `system`. */
    function init() {
      applyTheme()
      if (typeof matchMedia === 'function') {
        matchMedia(DARK_QUERY).addEventListener('change', (event) => {
          systemDark.value = event.matches
          applyTheme()
        })
      }
    }

    function toggleNav() {
      navCollapsed.value = !navCollapsed.value
    }

    return { theme, navCollapsed, mobileNavOpen, resolvedTheme, setTheme, init, toggleNav }
  },
  { persist: { key: 'td-layout', pick: ['theme', 'navCollapsed'] } },
)
