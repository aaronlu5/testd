<template>
  <RouterLink to="/" class="brand" aria-label="Testd home">
    <span class="brand__full">
      <img class="td-on-dark" src="/images/testd-logo-dark-bg.png" alt="Testd" height="28" />
      <img class="td-on-light" src="/images/testd-logo-light-bg.png" alt="" height="28" />
    </span>
    <span class="brand__mark">
      <img class="td-on-dark" src="/images/testd-mark-dark-bg.png" alt="Testd" height="28" />
      <img class="td-on-light" src="/images/testd-mark-light-bg.png" alt="" height="28" />
    </span>
  </RouterLink>
</template>

<style scoped>
.brand {
  display: inline-flex;
  align-items: center;
  border-radius: var(--td-radius-sm);
}
.brand img {
  height: 1.75rem;
  width: auto;
}
.brand__mark {
  display: none;
}
@media (max-width: 47.99rem) {
  .brand__full {
    display: none;
  }
  .brand__mark {
    display: inline-flex;
  }
}
</style>
