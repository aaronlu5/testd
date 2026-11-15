<template>
  <div class="home" data-testid="home">
    <section class="home-hero">
      <h1 class="td-sr-only">Testd: test orchestration platform</h1>
      <img
        class="home-logo td-on-light"
        src="/images/testd-logo-light-bg.png"
        alt="Testd"
        height="64"
      />
      <img
        class="home-logo td-on-dark"
        src="/images/testd-logo-dark-bg.png"
        alt="Testd"
        height="64"
      />
      <p class="home-motto" data-testid="home-motto">
        Automate regression tests, then turn up the pressure: repeatable runs, controlled
        concurrency, full visibility.
      </p>
    </section>

    <section aria-labelledby="home-flow-title">
      <h2 id="home-flow-title" class="section-title">How it works</h2>
      <ol class="flow" data-testid="home-flow">
        <li v-for="(step, index) in steps" :key="step.title" class="flow-item">
          <RouterLink :to="step.to" class="flow-node" :data-testid="`home-step-${index + 1}`">
            <span class="flow-number">{{ index + 1 }}</span>
            <strong class="flow-title">{{ step.title }}</strong>
            <span class="flow-text">{{ step.text }}</span>
          </RouterLink>
          <span v-if="index < steps.length - 1" class="flow-arrow" aria-hidden="true"></span>
        </li>
      </ol>
      <p class="flow-branch">
        Regression: rerun the same Suite on every change and compare outcomes. Stress: raise the
        Suite's concurrency, up to the Environment's limit, to apply parallel load. Breakpoints let
        you pause a Run mid-flow to inspect it.
      </p>
    </section>

    <section class="home-map" aria-labelledby="home-map-title">
      <h2 id="home-map-title" class="section-title">How the pieces fit together</h2>
      <ComponentMap />
    </section>
  </div>
</template>

<script setup lang="ts">
import ComponentMap from './ComponentMap.vue'

const steps = [
  {
    title: 'Define scenarios',
    text: 'Create Test Data for the cases to cover.',
    to: '/test-data',
  },
  {
    title: 'Build Tests',
    text: 'Chain Steps into a repeatable functional flow.',
    to: '/tests',
  },
  {
    title: 'Group into Suites',
    text: 'Assemble a regression pack from your Tests.',
    to: '/suites',
  },
  {
    title: 'Run at scale',
    text: 'Run for regression, or in parallel to stress a target.',
    to: '/suite-runs/new',
  },
  {
    title: 'Inspect & compare',
    text: 'Follow Runs live, find failures, rerun after fixes.',
    to: '/runs',
  },
]
</script>

<style scoped>
.home {
  max-width: 68rem;
  margin: 0 auto;
  padding: var(--td-space-5) 0 var(--td-space-7);
}
.home-hero {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: var(--td-space-7);
  padding: var(--td-space-7) var(--td-space-4);
  text-align: center;
  background:
    radial-gradient(60% 90% at 50% 0%, var(--td-accent-soft), transparent 70%),
    linear-gradient(var(--td-border) 1px, transparent 1px) 0 0 / 100% 2.5rem,
    var(--td-surface);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-lg);
  overflow: hidden;
}
.home-hero::after {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(70% 70% at 50% 40%, transparent, var(--td-surface) 95%);
  pointer-events: none;
}
.home-hero > * {
  position: relative;
  z-index: 1;
}
.home-logo {
  height: 4rem;
  width: auto;
}
.home-motto {
  margin: var(--td-space-4) auto 0;
  max-width: 38rem;
  font-size: var(--td-text-lg);
  color: var(--td-text-muted);
  text-wrap: balance;
}
.section-title {
  margin-bottom: var(--td-space-4);
  text-align: center;
  font-size: var(--td-text-md);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--td-text-muted);
}
.home-map {
  margin-top: var(--td-space-7);
}

.flow {
  display: flex;
  align-items: stretch;
  justify-content: center;
  margin: 0;
  padding: 0;
  list-style: none;
}
.flow-item {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  min-width: 0;
}
.flow-node {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  gap: var(--td-space-1);
  height: 100%;
  padding: var(--td-space-4) var(--td-space-3);
  text-align: center;
  text-decoration: none;
  color: var(--td-text);
  background: var(--td-surface);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-lg);
  transition:
    border-color var(--td-dur-fast) var(--td-ease),
    transform var(--td-dur-fast) var(--td-ease);
}
.flow-node:hover {
  color: var(--td-text);
  border-color: var(--td-accent);
  transform: translateY(-2px);
}
.flow-number {
  display: inline-grid;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  margin-bottom: var(--td-space-1);
  font-family: var(--td-font-mono);
  font-size: var(--td-text-sm);
  font-weight: 600;
  color: var(--td-on-accent);
  background: var(--td-accent);
  border-radius: var(--td-radius-sm);
}
.flow-text {
  font-size: var(--td-text-sm);
  color: var(--td-text-muted);
}
.flow-arrow {
  flex: 0 0 1.5rem;
  height: 1px;
  background: var(--td-border-strong);
}
.flow-branch {
  max-width: 48rem;
  margin: var(--td-space-5) auto 0;
  text-align: center;
  font-size: var(--td-text-sm);
  color: var(--td-text-muted);
}

@media (max-width: 63.99rem) {
  .flow {
    flex-direction: column;
    align-items: stretch;
  }
  .flow-item {
    flex-direction: column;
  }
  .flow-node {
    width: 100%;
  }
  .flow-arrow {
    flex: 0 0 1rem;
    width: 1px;
    height: 1rem;
  }
}
</style>
