<template>
  <div class="app-shell" :class="{ 'is-collapsed': layout.navCollapsed }">
    <a class="app-shell__skip" href="#main">Skip to content</a>
    <TopBar>
      <template #widgets><slot name="widgets" /></template>
    </TopBar>
    <MainNav />
    <main id="main" class="app-shell__main" tabindex="-1">
      <div class="app-shell__content">
        <slot />
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { useLayout } from '~/stores/layout'
import MainNav from './MainNav.vue'
import TopBar from './TopBar.vue'

const layout = useLayout()
</script>

<style scoped>
.app-shell {
  min-height: 100%;
}
.app-shell__skip {
  position: fixed;
  left: var(--td-space-3);
  top: -4rem;
  z-index: calc(var(--td-z-toast) + 1);
  padding: var(--td-space-2) var(--td-space-3);
  color: var(--td-on-accent);
  background: var(--td-accent);
  border-radius: var(--td-radius-md);
}
.app-shell__skip:focus {
  top: var(--td-space-3);
}
.app-shell__main {
  min-height: 100vh;
  padding-top: var(--td-topbar-h);
  padding-left: var(--td-nav-w);
  transition: padding-left var(--td-dur) var(--td-ease);
  outline: none;
}
.is-collapsed .app-shell__main {
  padding-left: var(--td-nav-rail-w);
}
.app-shell__content {
  max-width: var(--td-content-max);
  margin: 0 auto;
  padding: var(--td-space-5);
}
@media (max-width: 47.99rem) {
  .app-shell__main,
  .is-collapsed .app-shell__main {
    padding-left: 0;
  }
  .app-shell__content {
    padding: var(--td-space-4);
  }
}
</style>
