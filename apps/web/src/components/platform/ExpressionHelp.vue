<template>
  <details class="help" data-testid="expression-help">
    <summary class="help__summary">Expression help</summary>
    <div class="help__body">
      <p>
        Wrap a reference in <code v-pre>{{}}</code> to use it in any parameter. A parameter that is
        exactly one reference keeps its type (number, object, …).
      </p>
      <div class="td-table-wrap">
        <table class="td-table">
          <tbody>
            <tr>
              <th scope="row">
                <code v-pre>{{ testData.order.id }}</code>
              </th>
              <td>A value from the selected Test Data.</td>
            </tr>
            <tr>
              <th scope="row">
                <code v-pre>{{ global.runId }}</code>
              </th>
              <td>
                A global variable, such as <code>runId</code>, <code>runNumber</code> or
                <code>testId</code>. See <RouterLink to="/references">References</RouterLink>.
              </td>
            </tr>
            <tr>
              <th scope="row">
                <code v-pre>{{ variables.orderId }}</code>
              </th>
              <td>A Test variable (see Variables).</td>
            </tr>
            <tr>
              <th scope="row">
                <code v-pre>{{ environment.region }}</code>
              </th>
              <td>A non-secret value of the Environment.</td>
            </tr>
            <tr v-if="previous.length > 0">
              <th scope="row">
                <code v-pre>{{steps.</code><code>{{ previous[0] }}</code
                ><code v-pre>.output.field}}</code>
              </th>
              <td>
                The output of an earlier Step. Available:
                <code v-for="id in previous" :key="id" class="help__id">{{ id }}</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="td-muted help__note">
        Secrets cannot be referenced; they come from Environment targets.
      </p>
    </div>
  </details>
</template>

<script setup lang="ts">
defineProps<{ previous: string[] }>()
</script>

<style scoped>
.help {
  margin-bottom: var(--td-space-4);
  font-size: var(--td-text-sm);
}
.help__summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--td-accent-text);
}
.help__body {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-2);
  margin-top: var(--td-space-2);
}
.help__body p {
  margin: 0;
}
.help__id {
  margin-right: var(--td-space-1);
}
.help__note {
  margin-top: var(--td-space-1);
}
</style>
