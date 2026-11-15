<template>
  <aside
    class="side-nav"
    :class="{ 'is-collapsed': layout.navCollapsed, 'is-open': layout.mobileNavOpen }"
    data-testid="side-nav"
  >
    <nav aria-label="Main navigation" class="side-nav__scroll">
      <section v-for="group in navGroups" :key="group.slug" class="side-nav__group">
        <h2 class="side-nav__heading">{{ group.label }}</h2>
        <ul class="side-nav__list" role="list">
          <li v-for="item in group.items" :key="item.slug">
            <RouterLink
              :to="item.to"
              class="side-nav__link"
              :class="{ 'is-active': isNavActive(item, route.name) }"
              :aria-current="isNavActive(item, route.name) ? 'page' : undefined"
              :title="layout.navCollapsed ? item.label : undefined"
              :data-testid="`nav-${item.slug}`"
            >
              <Icon :name="item.icon" :size="18" />
              <span class="side-nav__label">{{ item.label }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>
    </nav>
    <div class="side-nav__foot td-small td-faint">Local mode</div>
  </aside>
  <div
    v-if="layout.mobileNavOpen"
    class="side-nav__scrim"
    aria-hidden="true"
    @click="layout.mobileNavOpen = false"
  ></div>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '~/components/ui/Icon.vue'
import { useLayout } from '~/stores/layout'
import { isNavActive, navGroups } from './nav'

const layout = useLayout()
const route = useRoute()

watch(
  () => route.fullPath,
  () => {
    layout.mobileNavOpen = false
  },
)
</script>

<style scoped>
.side-nav {
  position: fixed;
  top: var(--td-topbar-h);
  bottom: 0;
  left: 0;
  z-index: var(--td-z-nav);
  display: flex;
  flex-direction: column;
  width: var(--td-nav-w);
  background: var(--td-surface);
  border-right: 1px solid var(--td-border);
  transition: width var(--td-dur) var(--td-ease);
}
.side-nav__scroll {
  flex: 1 1 auto;
  overflow-x: hidden;
  overflow-y: auto;
  padding: var(--td-space-4) var(--td-space-3);
}
.side-nav__group + .side-nav__group {
  margin-top: var(--td-space-5);
}
.side-nav__heading {
  margin: 0 0 var(--td-space-2);
  padding: 0 var(--td-space-3);
  font-size: var(--td-text-xs);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--td-text-faint);
  white-space: nowrap;
}
.side-nav__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.side-nav__link {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--td-space-3);
  min-height: 2.25rem;
  padding: 0 var(--td-space-3);
  font-size: var(--td-text-sm);
  font-weight: 500;
  white-space: nowrap;
  color: var(--td-text-muted);
  text-decoration: none;
  border-radius: var(--td-radius-md);
}
.side-nav__link:hover {
  color: var(--td-text);
  background: var(--td-surface-3);
}
.side-nav__link.is-active {
  color: var(--td-accent-text);
  background: var(--td-accent-soft);
}
.side-nav__link.is-active::before {
  content: '';
  position: absolute;
  left: -0.75rem;
  top: 0.4rem;
  bottom: 0.4rem;
  width: 3px;
  background: var(--td-accent);
  border-radius: 0 3px 3px 0;
}
.side-nav__foot {
  padding: var(--td-space-3) var(--td-space-5);
  border-top: 1px solid var(--td-border);
  white-space: nowrap;
}

/* Icon rail (desktop) */
.is-collapsed {
  width: var(--td-nav-rail-w);
}
.is-collapsed .side-nav__heading,
.is-collapsed .side-nav__foot {
  display: none;
}
.is-collapsed .side-nav__group + .side-nav__group {
  margin-top: var(--td-space-3);
  padding-top: var(--td-space-3);
  border-top: 1px solid var(--td-border);
}
.is-collapsed .side-nav__link {
  justify-content: center;
  padding: 0;
}
.is-collapsed .side-nav__label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
.is-collapsed .side-nav__link.is-active::before {
  left: -0.75rem;
}

/* Drawer (mobile) */
@media (max-width: 47.99rem) {
  .side-nav,
  .side-nav.is-collapsed {
    width: min(18rem, 86vw);
    transform: translateX(-100%);
    transition: transform var(--td-dur) var(--td-ease);
    z-index: var(--td-z-overlay);
    box-shadow: none;
  }
  .side-nav.is-open {
    transform: none;
    box-shadow: var(--td-shadow-2);
  }
  .side-nav.is-collapsed .side-nav__heading,
  .side-nav.is-collapsed .side-nav__foot {
    display: block;
  }
  .side-nav.is-collapsed .side-nav__link {
    justify-content: flex-start;
    padding: 0 var(--td-space-3);
  }
  .side-nav.is-collapsed .side-nav__label {
    position: static;
    width: auto;
    height: auto;
    clip: auto;
  }
  .side-nav__link {
    min-height: 2.75rem;
  }
  .side-nav__scrim {
    position: fixed;
    inset: var(--td-topbar-h) 0 0 0;
    z-index: calc(var(--td-z-overlay) - 1);
    background: var(--td-overlay);
  }
}
</style>
