import type { EnvironmentConfig, EnvironmentTarget, SecretReference, TargetKind } from '~/api/types'

/**
 * Form model for the Environment editor. The API stores `EnvironmentConfig`; the form works with
 * plain strings (one entry per line for lists) and converts both ways, dropping empty optional
 * fields so a saved file stays tidy. No secret value ever appears here, only references.
 */

export const TARGET_KINDS: { value: TargetKind; label: string }[] = [
  { value: 'http', label: 'HTTP / API Management' },
  { value: 'azureBlob', label: 'Azure Blob Storage' },
  { value: 'azureServiceBus', label: 'Azure Service Bus' },
  { value: 'sqlServer', label: 'SQL Server' },
]

export const CLASSIFICATIONS = ['LOCAL', 'TEST', 'STAGING', 'PRODUCTION'] as const
export type Classification = (typeof CLASSIFICATIONS)[number]

/** Classifications that must use Key Vault references only (plain text is for local/test use). */
export const KEY_VAULT_ONLY: readonly string[] = ['STAGING', 'PRODUCTION']
export const allowsPlainText = (classification: string): boolean =>
  !KEY_VAULT_ONLY.includes(classification)

export const HTTP_METHOD_CHOICES = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']
export const BLOB_OPERATION_CHOICES = ['upload', 'download']
export const SERVICE_BUS_OPERATION_CHOICES = ['send', 'inspect']
export const SQL_OPERATION_CHOICES = ['query', 'insert', 'update', 'delete']

export const LIMIT_FIELDS = [
  { key: 'maxStepTimeoutSeconds', label: 'Max Step timeout (seconds)' },
  { key: 'maxRetryAttempts', label: 'Max retry attempts' },
  { key: 'maxPayloadCaptureBytes', label: 'Max captured payload (bytes)' },
  { key: 'maxArtifactBytes', label: 'Max artifact size (bytes)' },
  { key: 'maxSuiteSize', label: 'Max Suite size (items)' },
  { key: 'maxSuiteConcurrency', label: 'Max Suite concurrency' },
] as const
export type LimitKey = (typeof LIMIT_FIELDS)[number]['key']

export type TargetDraft = {
  /** Stable key for list rendering; not saved. */
  uid: number
  name: string
  kind: TargetKind
  // http
  baseUrl: string
  allowedPaths: string
  allowedMethods: string[]
  correlationHeaders: boolean
  // azureBlob
  accountUrl: string
  allowedContainers: string
  blobOperations: string[]
  allowedBlobPrefixes: string
  // azureServiceBus
  namespace: string
  allowedEntities: string
  serviceBusOperations: string[]
  // sqlServer
  server: string
  database: string
  allowedSchemas: string
  sqlOperations: string[]
  /** `authentication` for HTTP, `credential` for Blob and Service Bus. */
  secret?: SecretReference
}

export type ValueRow = {
  uid: number
  key: string
  value: string
  original?: string | number | boolean
}

export type EnvironmentDraft = {
  id: string
  name: string
  classification: Classification
  limits: Partial<Record<LimitKey, string>>
  values: ValueRow[]
  targets: TargetDraft[]
}

let nextUid = 1
export const uid = (): number => nextUid++

export const linesToArray = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')

export const arrayToLines = (items: readonly string[] | undefined): string =>
  (items ?? []).join('\n')

export const blankTarget = (kind: TargetKind = 'http'): TargetDraft => ({
  uid: uid(),
  name: '',
  kind,
  baseUrl: '',
  allowedPaths: '',
  allowedMethods: [],
  correlationHeaders: true,
  accountUrl: '',
  allowedContainers: '',
  blobOperations: [],
  allowedBlobPrefixes: '',
  namespace: '',
  allowedEntities: '',
  serviceBusOperations: [],
  server: '',
  database: '',
  allowedSchemas: '',
  sqlOperations: [],
})

export const blankEnvironment = (): EnvironmentDraft => ({
  id: '',
  name: '',
  classification: 'TEST',
  limits: {},
  values: [],
  targets: [],
})

const targetToDraft = (name: string, target: EnvironmentTarget): TargetDraft => {
  const draft = { ...blankTarget(target.kind), name }
  if (target.kind === 'http') {
    draft.baseUrl = target.baseUrl
    draft.allowedPaths = arrayToLines(target.allowedPaths)
    draft.allowedMethods = [...(target.allowedMethods ?? [])]
    draft.correlationHeaders = target.correlationHeaders !== false
    // The Phase 1 `secretRef` name is always a local plain-text secret; edit it as a reference.
    draft.secret =
      target.authentication ??
      (target.secretRef
        ? { type: 'secretReference', provider: 'localPlainText', name: target.secretRef }
        : undefined)
  } else if (target.kind === 'azureBlob') {
    draft.accountUrl = target.accountUrl
    draft.allowedContainers = arrayToLines(target.allowedContainers)
    draft.blobOperations = [...(target.allowedOperations ?? [])]
    draft.allowedBlobPrefixes = arrayToLines(target.allowedBlobPrefixes)
    draft.secret = target.credential
  } else if (target.kind === 'sqlServer') {
    draft.server = target.server
    draft.database = target.database
    draft.allowedSchemas = arrayToLines(target.allowedSchemas)
    draft.sqlOperations = [...(target.allowedOperations ?? [])]
    draft.secret = target.credential
  } else {
    draft.namespace = target.fullyQualifiedNamespace ?? target.namespace ?? ''
    draft.allowedEntities = arrayToLines(target.allowedEntities)
    draft.serviceBusOperations = [...(target.allowedOperations ?? [])]
    draft.secret = target.credential
  }
  return draft
}

export const toDraft = (environment: EnvironmentConfig): EnvironmentDraft => ({
  id: environment.id,
  name: environment.name,
  classification: environment.classification,
  limits: Object.fromEntries(
    Object.entries(environment.limits ?? {}).map(([key, value]) => [key, String(value)]),
  ),
  values: Object.entries(environment.values ?? {}).map(([key, value]) => ({
    uid: uid(),
    key,
    value: String(value),
    original: value,
  })),
  targets: Object.entries(environment.targets).map(([name, target]) => targetToDraft(name, target)),
})

const cleanReference = (reference: SecretReference | undefined): SecretReference | undefined => {
  if (!reference || reference.name.trim() === '') return undefined
  return {
    type: 'secretReference',
    provider: reference.provider,
    name: reference.name.trim(),
    ...(reference.usage ? { usage: reference.usage } : {}),
  }
}

const orUndefined = <T>(items: T[]): T[] | undefined => (items.length > 0 ? items : undefined)

const draftToTarget = (draft: TargetDraft): EnvironmentTarget => {
  const secret = cleanReference(draft.secret)
  if (draft.kind === 'http') {
    const methods = orUndefined(draft.allowedMethods)
    return {
      kind: 'http',
      baseUrl: draft.baseUrl.trim(),
      allowedPaths: linesToArray(draft.allowedPaths),
      ...(methods ? { allowedMethods: methods } : {}),
      ...(secret ? { authentication: secret } : {}),
      // Only written when it differs from the default (on).
      ...(draft.correlationHeaders ? {} : { correlationHeaders: false }),
    }
  }
  if (draft.kind === 'azureBlob') {
    const operations = orUndefined(draft.blobOperations)
    const prefixes = orUndefined(linesToArray(draft.allowedBlobPrefixes))
    return {
      kind: 'azureBlob',
      accountUrl: draft.accountUrl.trim(),
      allowedContainers: linesToArray(draft.allowedContainers),
      ...(operations ? { allowedOperations: operations as ('upload' | 'download')[] } : {}),
      ...(prefixes ? { allowedBlobPrefixes: prefixes } : {}),
      ...(secret ? { credential: secret } : {}),
    }
  }
  if (draft.kind === 'sqlServer') {
    const schemas = orUndefined(linesToArray(draft.allowedSchemas))
    const sqlOperations = orUndefined(draft.sqlOperations)
    return {
      kind: 'sqlServer',
      server: draft.server.trim(),
      database: draft.database.trim(),
      ...(schemas ? { allowedSchemas: schemas } : {}),
      ...(sqlOperations
        ? { allowedOperations: sqlOperations as ('query' | 'insert' | 'update' | 'delete')[] }
        : {}),
      ...(secret ? { credential: secret } : {}),
    }
  }
  const operations = orUndefined(draft.serviceBusOperations)
  return {
    kind: 'azureServiceBus',
    fullyQualifiedNamespace: draft.namespace.trim(),
    allowedEntities: linesToArray(draft.allowedEntities),
    ...(operations ? { allowedOperations: operations as ('send' | 'inspect')[] } : {}),
    ...(secret ? { credential: secret } : {}),
  }
}

/** Keeps a value's original type (number, boolean) unless the author changed its text. */
const valueOf = (row: ValueRow): string | number | boolean => {
  if (row.original !== undefined && String(row.original) === row.value) return row.original
  return row.value
}

export const fromDraft = (draft: EnvironmentDraft): EnvironmentConfig => {
  const limits: Record<string, number> = {}
  for (const { key } of LIMIT_FIELDS) {
    const text = draft.limits[key]?.trim()
    if (text) limits[key] = Number(text)
  }
  const values: Record<string, string | number | boolean> = {}
  for (const row of draft.values) if (row.key.trim() !== '') values[row.key.trim()] = valueOf(row)
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    classification: draft.classification,
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
    ...(Object.keys(values).length > 0 ? { values } : {}),
    targets: Object.fromEntries(
      draft.targets.map((target) => [target.name.trim(), draftToTarget(target)]),
    ),
  }
}

export type DraftIssue = {
  path: string
  message: string
  /** The target card this issue belongs to, when it is about a single target. */
  targetUid?: number
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const TARGET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Quick checks before a round trip; the server validates everything again and wins. */
export const draftIssues = (draft: EnvironmentDraft, options: { isNew: boolean }): DraftIssue[] => {
  const issues: DraftIssue[] = []
  if (options.isNew && !ID_PATTERN.test(draft.id.trim()))
    issues.push({
      path: '/id',
      message: 'The id uses lower-case letters, digits and "-", starting with a letter or digit.',
    })
  if (draft.name.trim() === '')
    issues.push({ path: '/name', message: 'Give the Environment a name.' })
  const seen = new Set<string>()
  for (const target of draft.targets) {
    const name = target.name.trim()
    if (!TARGET_NAME_PATTERN.test(name))
      issues.push({
        path: '/targets',
        message: `"${name || '(empty)'}" is not a valid target name (letters, digits, "-" or "_").`,
        targetUid: target.uid,
      })
    else if (seen.has(name))
      issues.push({
        path: '/targets',
        message: `Target "${name}" appears twice.`,
        targetUid: target.uid,
      })
    seen.add(name)
  }
  for (const [key, text] of Object.entries(draft.limits)) {
    if (text && !/^[1-9][0-9]*$/.test(text.trim()))
      issues.push({ path: `/limits/${key}`, message: 'Limits are whole numbers of at least 1.' })
  }
  if (!allowsPlainText(draft.classification)) {
    for (const target of draft.targets) {
      if (target.secret?.provider === 'localPlainText' && target.secret.name.trim() !== '')
        issues.push({
          path: `/targets/${target.name}/secret`,
          message: `${draft.classification} Environments must use Key Vault references; target "${target.name}" uses a local plain-text secret.`,
          targetUid: target.uid,
        })
    }
  }
  return issues
}

/** Provider and name of a reference, for summaries. */
export const describeReference = (reference: SecretReference | undefined): string =>
  reference
    ? `${reference.provider === 'keyVault' ? 'Key Vault' : 'Local'}: ${reference.name}`
    : 'none'

/** Maps a server issue path (`/targets/api/baseUrl`) to the target it belongs to. */
export const targetOfIssue = (path: string): string | undefined =>
  /^\/targets\/([^/]+)/.exec(path)?.[1]

const TARGET_FIELDS: Record<TargetKind, readonly string[]> = {
  http: [
    'baseUrl',
    'allowedPaths',
    'allowedMethods',
    'secretRef',
    'authentication',
    'correlationHeaders',
  ],
  azureBlob: [
    'accountUrl',
    'allowedContainers',
    'allowedOperations',
    'allowedBlobPrefixes',
    'credential',
  ],
  azureServiceBus: [
    'namespace',
    'fullyQualifiedNamespace',
    'allowedEntities',
    'allowedOperations',
    'credential',
  ],
  sqlServer: ['server', 'database', 'allowedSchemas', 'allowedOperations', 'credential'],
}

/**
 * The server validates a target against every target kind (a JSON Schema oneOf) and reports the
 * failures of all of them. Keep only what concerns this target's own kind and fields.
 */
export const isRelevantTargetIssue = (kind: TargetKind, path: string, message: string): boolean => {
  const field = /^\/targets\/[^/]+\/([^/]+)/.exec(path)?.[1]
  if (!field || !TARGET_FIELDS[kind].includes(field)) return false
  return !/additional properties|equal to constant/.test(message)
}

export const targetSummary = (target: EnvironmentTarget): string =>
  target.kind === 'http'
    ? target.baseUrl
    : target.kind === 'azureBlob'
      ? target.accountUrl
      : target.kind === 'sqlServer'
        ? `${target.server} / ${target.database}`
        : (target.fullyQualifiedNamespace ?? target.namespace ?? '')
