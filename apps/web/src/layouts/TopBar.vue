<template>
  <header class="top-bar" data-testid="top-bar">
    <div class="top-bar__start">
      <button
        type="button"
        class="top-bar__icon-btn"
        :aria-label="
          isMobile
            ? 'Open navigation'
            : layout.navCollapsed
              ? 'Expand navigation'
              : 'Collapse navigation'
        "
        :aria-expanded="isMobile ? layout.mobileNavOpen : !layout.navCollapsed"
        data-testid="nav-toggle"
        @click="onToggleNav"
      >
        <Icon name="panel-left" :size="20" />
      </button>
      <BrandLogo />
    </div>

    <button
      type="button"
      class="top-bar__search"
      aria-label="Search pages"
      data-testid="quick-search"
      @click="searchOpen = true"
    >
      <Icon name="search" :size="16" />
      <span class="top-bar__search-text">Jump to a page</span>
      <kbd class="top-bar__kbd">Ctrl K</kbd>
    </button>

    <div class="top-bar__end">
      <!-- Platform widgets (environment, Mock API monitor, Service Bus inspector) are supplied by the layout. -->
      <slot name="widgets" />
      <ThemeMenu />
      <FullscreenToggle class="td-hide-sm" />
      <UserMenu />
    </div>
  </header>
  <CommandSearch v-model="searchOpen" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '~/components/ui/Icon.vue'
import { useLayout } from '~/stores/layout'
import BrandLogo from './BrandLogo.vue'
import CommandSearch from './CommandSearch.vue'
import FullscreenToggle from './FullscreenToggle.vue'
import ThemeMenu from './ThemeMenu.vue'
import UserMenu from './UserMenu.vue'

const layout = useLayout()
const searchOpen = ref(false)
const MOBILE = '(max-width: 47.99rem)'
const isMobile = ref(typeof matchMedia === 'function' && matchMedia(MOBILE).matches)

let mq: MediaQueryList | undefined
const onMq = (e: MediaQueryListEvent) => {
  isMobile.value = e.matches
  if (!e.matches) layout.mobileNavOpen = false
}

function onToggleNav() {
  if (isMobile.value) layout.mobileNavOpen = !layout.mobileNavOpen
  else layout.toggleNav()
}

function onShortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    searchOpen.value = true
  }
}

onMounted(() => {
  if (typeof matchMedia === 'function') {
    mq = matchMedia(MOBILE)
    mq.addEventListener('change', onMq)
  }
  window.addEventListener('keydown', onShortcut)
})
onBeforeUnmount(() => {
  mq?.removeEventListener('change', onMq)
  window.removeEventListener('keydown', onShortcut)
})
</script>

<style scoped>
.top-bar {
  position: fixed;
  inset: 0 0 auto 0;
  z-index: var(--td-z-topbar);
  display: flex;
  align-items: center;
  gap: var(--td-space-4);
  height: var(--td-topbar-h);
  padding: 0 var(--td-space-4);
  background: color-mix(in srgb, var(--td-surface) 88%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--td-border);
}
.top-bar__start,
.top-bar__end {
  display: flex;
  align-items: center;
  gap: var(--td-space-2);
}
.top-bar__end {
  margin-left: auto;
}
.top-bar__icon-btn {
  display: grid;
  place-items: center;
  width: 2.25rem;
  height: 2.25rem;
  color: var(--td-text-muted);
  background: transparent;
  border: 0;
  border-radius: var(--td-radius-md);
}
.top-bar__icon-btn:hover {
  color: var(--td-text);
  background: var(--td-surface-3);
}
.top-bar__search {
  display: flex;
  align-items: center;
  gap: var(--td-space-2);
  width: min(22rem, 100%);
  height: 2.25rem;
  padding: 0 var(--td-space-3);
  font-size: var(--td-text-sm);
  color: var(--td-text-faint);
  background: var(--td-surface-2);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-md);
}
.top-bar__search:hover {
  border-color: var(--td-border-strong);
  color: var(--td-text-muted);
}
.top-bar__search-text {
  flex: 1 1 auto;
  text-align: left;
}
.top-bar__kbd {
  padding: 0.05rem 0.4rem;
  font-size: var(--td-text-xs);
  color: var(--td-text-faint);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-sm);
}
@media (max-width: 47.99rem) {
  .top-bar {
    gap: var(--td-space-2);
    padding: 0 var(--td-space-2);
  }
  .top-bar__search {
    width: 2.25rem;
    padding: 0;
    justify-content: center;
    margin-left: auto;
  }
  .top-bar__search-text,
  .top-bar__kbd {
    display: none;
  }
  .top-bar__end {
    margin-left: 0;
  }
}
</style>
