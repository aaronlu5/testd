<template>
  <PageHeader title="References" subtitle="Test Platform" />

  <div class="refs">
    <UiCard data-testid="references-intro">
      <h2>Using references</h2>
      <p>
        A reference is a name in double braces, such as <code v-pre>{{ global.runId }}</code
        >. It is replaced with its value when a Run starts, so the same Test and Test Data can
        produce different, unique data every time.
      </p>
      <p>
        References work in <strong>Test Data</strong> values (global variables only),
        <strong>Test variables</strong> and <strong>Step parameters</strong>. A value that is
        exactly one reference keeps its type, so <code v-pre>{{ global.runNumber }}</code> stays a
        number. Mixed with text it becomes text:
        <code v-pre>order-{{ global.runNumber }}</code> gives <code>order-42</code>.
      </p>
    </UiCard>

    <UiCard data-testid="global-variables">
      <h2>Global variables</h2>
      <p class="td-muted">
        Read-only values that the platform provides to every Run. They hold only letters, digits and
        hyphens, so they are safe in names, keys, URLs and file paths. A value is fixed for the
        whole Run (a retried Step sees the same value) and a new Run, including a rerun, gets new
        run values.
      </p>

      <LoadingState v-if="isPending" label="Loading global variables…" />
      <ProblemAlert v-else-if="error" :error="error" retryable @retry="() => refetch()" />
      <template v-else>
        <section v-for="group in groups" :key="group.scope" class="refs__group">
          <h3>{{ group.title }}</h3>
          <p class="td-small td-muted">{{ group.summary }}</p>
          <div
            class="td-table-wrap"
            tabindex="0"
            role="region"
            :aria-label="`${group.title} global variables`"
          >
            <table class="td-table">
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Type</th>
                  <th scope="col">What it holds</th>
                  <th scope="col">Example value</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="variable in group.items"
                  :key="variable.name"
                  :data-testid="`global-${variable.name}`"
                >
                  <td class="refs__nowrap">
                    <code>{{ reference(variable.name) }}</code>
                  </td>
                  <td>{{ variable.type }}</td>
                  <td>{{ variable.description }}</td>
                  <td>
                    <code>{{ variable.example }}</code>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </UiCard>

    <UiCard data-testid="reference-examples">
      <h2>Examples</h2>

      <h3>Unique Test Data on every Run</h3>
      <p class="td-small td-muted">
        Save this as Test Data. Each Run gets its own order id and customer e-mail address:
      </p>
      <pre tabindex="0"><code>{{ dataExample }}</code></pre>
      <p class="td-small td-muted">
        With Run number 42 and seed <code>9f3a1c7e</code> a Step reading
        <code v-pre>{{ testData.order.id }}</code> gets <code>ORD-42-9f3a1c7e</code>.
      </p>

      <h3>Blob names that never collide</h3>
      <p class="td-small td-muted">In a Blob upload Step's Blob Name:</p>
      <pre tabindex="0"><code>{{ blobExample }}</code></pre>
      <p class="td-small td-muted">
        Gives <code>runs/20261020/42/order.json</code>. The same value is used by every attempt of
        the Step, so a retry recognises its own earlier upload.
      </p>

      <h3>Linking data to a Test</h3>
      <p class="td-small td-muted">
        <code v-pre>{{ global.testId }}</code> never changes for a Test, so records created by
        different Runs of it can all carry the same link:
      </p>
      <pre tabindex="0"><code>{{ linkExample }}</code></pre>
    </UiCard>

    <UiCard data-testid="other-references">
      <h2>Other references</h2>
      <div class="td-table-wrap" tabindex="0" role="region" aria-label="Other references">
        <table class="td-table">
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">Where it works</th>
              <th scope="col">What it holds</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code v-pre>{{ testData.order.id }}</code>
              </td>
              <td>Test variables and Step parameters</td>
              <td>A value from the Test Data chosen for the Run, after its global variables.</td>
            </tr>
            <tr>
              <td>
                <code v-pre>{{ variables.orderId }}</code>
              </td>
              <td>Test variables and Step parameters</td>
              <td>A variable declared on the Test.</td>
            </tr>
            <tr>
              <td>
                <code v-pre>{{ environment.region }}</code>
              </td>
              <td>Test variables and Step parameters</td>
              <td>A non-secret value from the chosen Environment.</td>
            </tr>
            <tr>
              <td>
                <code v-pre>{{ steps.upload.output.etag }}</code>
              </td>
              <td>Step parameters</td>
              <td>The output of an earlier Step.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="td-small td-muted refs__foot">
        Secrets cannot be referenced anywhere; they come from Environment targets.
      </p>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import PageHeader from '~/components/PageHeader.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import UiCard from '~/components/ui/UiCard.vue'
import { useGlobalVariables } from '~/api/queries'

const { data, error, isPending, refetch } = useGlobalVariables()

const SCOPES = [
  {
    scope: 'run',
    title: 'Per Run',
    summary: 'Set when a Run is requested. Every Run, and every rerun, gets its own values.',
  },
  {
    scope: 'test',
    title: 'Per Test',
    summary: 'Belong to the Test, so they are the same in every Run of it.',
  },
  {
    scope: 'environment',
    title: 'Per Environment',
    summary: 'Describe the Environment the Run uses.',
  },
] as const

const groups = computed(() =>
  SCOPES.map((group) => ({
    ...group,
    items: (data.value ?? []).filter((variable) => variable.scope === group.scope),
  })).filter((group) => group.items.length > 0),
)

const reference = (name: string) => `{{ global.${name} }}`

const dataExample = `{
  "order": {
    "id": "ORD-{{ global.runNumber }}-{{ global.runSeed }}",
    "customerEmail": "buyer-{{ global.runSeed }}@test.local"
  }
}`
const blobExample = 'runs/{{ global.runDate }}/{{ global.runNumber }}/order.json'
const linkExample = `{
  "externalReference": "{{ global.testId }}",
  "note": "Created by Run {{ global.runNumber }}"
}`
</script>

<style scoped>
.refs {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-4);
  max-width: 64rem;
}
.refs h2 {
  margin: 0 0 var(--td-space-2);
}
.refs h3 {
  margin: var(--td-space-5) 0 var(--td-space-1);
  font-size: var(--td-text-md);
}
.refs p {
  margin: 0 0 var(--td-space-3);
}
.refs__group:first-of-type h3 {
  margin-top: var(--td-space-3);
}
.refs__nowrap {
  white-space: nowrap;
}
.refs__foot {
  margin: var(--td-space-3) 0 0;
}
pre {
  margin: 0 0 var(--td-space-2);
  font-size: var(--td-text-xs);
}
</style>
