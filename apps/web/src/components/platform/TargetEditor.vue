<template>
  <UiCard class="target target-card" :data-testid="`target-${model.name || 'new'}`">
    <template #header>
      <div class="target__head">
        <UiBadge>{{ kindLabel }}</UiBadge>
        <span class="target__name td-truncate">{{ model.name || 'New target' }}</span>
        <UiBadge v-if="issues.length > 0" variant="danger" :title="issues.join(' ')"
          >Needs attention</UiBadge
        >
        <UiIconButton
          class="target__remove"
          size="sm"
          variant="outline-danger"
          icon="trash"
          :label="`Remove target ${model.name || ''}`"
          @click="emit('remove')"
        />
      </div>
    </template>

    <UiAlert v-if="issues.length > 0" variant="danger" data-testid="target-issues">
      <ul class="target__issues">
        <li v-for="(message, index) in issues" :key="index">{{ message }}</li>
      </ul>
    </UiAlert>

    <div class="fields">
      <div class="td-field">
        <label :for="`${id}-name`" class="td-label">Target name</label>
        <input
          :id="`${id}-name`"
          v-model.trim="model.name"
          class="td-control td-control--sm"
          maxlength="64"
          autocomplete="off"
          placeholder="orders-api"
        />
        <div class="td-hint">Tests refer to this name; they never contain the address.</div>
      </div>

      <template v-if="model.kind === 'http'">
        <div class="td-field">
          <label :for="`${id}-base`" class="td-label">Base URL</label>
          <input
            :id="`${id}-base`"
            v-model.trim="model.baseUrl"
            class="td-control td-control--sm"
            autocomplete="off"
            placeholder="https://example.azure-api.net"
          />
          <div class="td-hint">
            https only (http is allowed for localhost). No credentials or query.
          </div>
        </div>
        <div class="td-field">
          <label :for="`${id}-paths`" class="td-label">Allowed paths (one per line)</label>
          <textarea
            :id="`${id}-paths`"
            v-model="model.allowedPaths"
            class="td-control td-control--sm td-mono"
            rows="3"
            spellcheck="false"
            placeholder="/orders/*"
          />
          <div class="td-hint">
            <code>*</code> matches one path segment, <code>**</code> several.
          </div>
        </div>
        <div class="td-field">
          <div class="td-label">Allowed methods</div>
          <div class="checks">
            <UiCheckbox
              v-for="method in HTTP_METHOD_CHOICES"
              :key="method"
              v-model="model.allowedMethods"
              :value="method"
              >{{ method }}</UiCheckbox
            >
          </div>
          <div class="td-hint">
            None selected means GET, HEAD, POST, PUT and PATCH. DELETE must be chosen.
          </div>
          <UiCheckbox v-model="model.correlationHeaders" class="target__extra">
            Send correlation headers (<code>x-correlation-id</code>,
            <code>x-test-platform-*</code>)
          </UiCheckbox>
        </div>
      </template>

      <template v-else-if="model.kind === 'azureBlob'">
        <div class="td-field">
          <label :for="`${id}-account`" class="td-label">Account URL</label>
          <input
            :id="`${id}-account`"
            v-model.trim="model.accountUrl"
            class="td-control td-control--sm"
            autocomplete="off"
            placeholder="https://example.blob.core.windows.net"
          />
          <div class="td-hint">No SAS token or query string.</div>
        </div>
        <div class="td-field">
          <label :for="`${id}-containers`" class="td-label"
            >Allowed containers (one per line)</label
          >
          <textarea
            :id="`${id}-containers`"
            v-model="model.allowedContainers"
            class="td-control td-control--sm td-mono"
            rows="3"
            spellcheck="false"
            placeholder="inbound-orders"
          />
        </div>
        <div class="td-field">
          <label :for="`${id}-prefixes`" class="td-label">Allowed blob prefixes (optional)</label>
          <textarea
            :id="`${id}-prefixes`"
            v-model="model.allowedBlobPrefixes"
            class="td-control td-control--sm td-mono"
            rows="2"
            spellcheck="false"
            placeholder="runs/"
          />
        </div>
        <div class="td-field">
          <div class="td-label">Allowed operations</div>
          <div class="checks">
            <UiCheckbox
              v-for="operation in BLOB_OPERATION_CHOICES"
              :key="operation"
              v-model="model.blobOperations"
              :value="operation"
              >{{ operation }}</UiCheckbox
            >
          </div>
          <div class="td-hint">None selected means upload and download.</div>
        </div>
      </template>

      <template v-else-if="model.kind === 'sqlServer'">
        <div class="td-field">
          <label :for="`${id}-server`" class="td-label">Server</label>
          <input
            :id="`${id}-server`"
            v-model.trim="model.server"
            class="td-control td-control--sm"
            autocomplete="off"
            placeholder="example.database.windows.net,1433"
          />
          <div class="td-hint">Host name, optionally followed by <code>,port</code>.</div>
        </div>
        <div class="td-field">
          <label :for="`${id}-database`" class="td-label">Database</label>
          <input
            :id="`${id}-database`"
            v-model.trim="model.database"
            class="td-control td-control--sm"
            autocomplete="off"
            placeholder="orders"
          />
        </div>
        <div class="td-field">
          <label :for="`${id}-schemas`" class="td-label"
            >Allowed schemas (optional, one per line)</label
          >
          <textarea
            :id="`${id}-schemas`"
            v-model="model.allowedSchemas"
            class="td-control td-control--sm td-mono"
            rows="2"
            spellcheck="false"
            placeholder="dbo"
          />
          <div class="td-hint">None listed means no schema restriction.</div>
        </div>
        <div class="td-field">
          <div class="td-label">Allowed operations</div>
          <div class="checks">
            <UiCheckbox
              v-for="operation in SQL_OPERATION_CHOICES"
              :key="operation"
              v-model="model.sqlOperations"
              :value="operation"
              >{{ operation }}</UiCheckbox
            >
          </div>
          <div class="td-hint">
            None selected means read-only (<code>query</code>). Changing data is never implied.
          </div>
        </div>
      </template>

      <template v-else>
        <div class="td-field">
          <label :for="`${id}-ns`" class="td-label">Namespace</label>
          <input
            :id="`${id}-ns`"
            v-model.trim="model.namespace"
            class="td-control td-control--sm"
            autocomplete="off"
            placeholder="example.servicebus.windows.net"
          />
        </div>
        <div class="td-field">
          <label :for="`${id}-entities`" class="td-label"
            >Allowed queues and topics (one per line)</label
          >
          <textarea
            :id="`${id}-entities`"
            v-model="model.allowedEntities"
            class="td-control td-control--sm td-mono"
            rows="3"
            spellcheck="false"
            placeholder="order-events"
          />
        </div>
        <div class="td-field">
          <div class="td-label">Allowed operations</div>
          <div class="checks">
            <UiCheckbox
              v-for="operation in SERVICE_BUS_OPERATION_CHOICES"
              :key="operation"
              v-model="model.serviceBusOperations"
              :value="operation"
              >{{
                operation === 'inspect'
                  ? 'inspect (peek, for the Service Bus Inspector)'
                  : operation
              }}</UiCheckbox
            >
          </div>
          <div class="td-hint">
            None selected means send only. <code>inspect</code> is never implied.
          </div>
        </div>
      </template>

      <div class="fields__wide">
        <SecretRefEditor
          v-model="model.secret"
          :label="model.kind === 'http' ? 'Authentication' : 'Credential'"
          :test-id="model.name || 'new'"
          :usages="usages"
          :allow-plain-text="allowPlainText"
          :known-local-names="knownLocalNames"
          :local-status="localStatus"
          :none-label="
            model.kind === 'http'
              ? 'None (no credential header)'
              : model.kind === 'sqlServer'
                ? 'None (use integrated / Entra authentication)'
                : 'None (use Entra / DefaultAzureCredential)'
          "
        />
      </div>
    </div>
  </UiCard>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import SecretRefEditor from '~/components/platform/SecretRefEditor.vue'
import UiAlert from '~/components/ui/UiAlert.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiCheckbox from '~/components/ui/UiCheckbox.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import type { SecretUsage } from '~/api/types'
import {
  BLOB_OPERATION_CHOICES,
  HTTP_METHOD_CHOICES,
  SERVICE_BUS_OPERATION_CHOICES,
  SQL_OPERATION_CHOICES,
  TARGET_KINDS,
  type TargetDraft,
} from './environment-form'

const model = defineModel<TargetDraft>({ required: true })
const props = withDefaults(
  defineProps<{
    allowPlainText: boolean
    knownLocalNames: string[]
    /** Local secret names that currently have a value. */
    setLocalNames: string[]
    /** Why this target needs attention; empty when it is fine. */
    issues?: string[]
  }>(),
  { issues: () => [] },
)
const emit = defineEmits<{ remove: [] }>()

const id = `target-${useId()}`
const kindLabel = computed(
  () => TARGET_KINDS.find((kind) => kind.value === model.value.kind)?.label,
)
const usages = computed<SecretUsage[]>(() =>
  model.value.kind === 'http' ? ['apiKey', 'bearerToken'] : ['connectionString'],
)
const localStatus = computed(() => {
  const reference = model.value.secret
  if (reference?.provider !== 'localPlainText' || !reference.name) return undefined
  const key = (name: string) => name.toLowerCase().replace(/-/g, '_')
  return props.setLocalNames.some((name) => key(name) === key(reference.name)) ? 'set' : 'missing'
})
</script>

<style scoped>
.target {
  margin-bottom: var(--td-space-4);
}
.target__head {
  display: flex;
  align-items: center;
  gap: var(--td-space-2);
  width: 100%;
  min-width: 0;
}
.target__name {
  font-weight: 650;
}
.target__remove {
  margin-left: auto;
}
.target__issues {
  margin: 0;
  padding-left: var(--td-space-5);
}
.target__extra {
  margin-top: var(--td-space-2);
}
.fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
  gap: var(--td-space-4);
}
.fields__wide {
  grid-column: 1 / -1;
}
.checks {
  display: flex;
  flex-wrap: wrap;
  gap: var(--td-space-2) var(--td-space-4);
}
.target :deep(.ui-alert) {
  margin-bottom: var(--td-space-4);
}
</style>
