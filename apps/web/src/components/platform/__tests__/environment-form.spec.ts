import { describe, expect, it } from 'vitest'
import type { EnvironmentConfig } from '~/api/types'
import {
  allowsPlainText,
  blankEnvironment,
  blankTarget,
  draftIssues,
  fromDraft,
  linesToArray,
  targetOfIssue,
  toDraft,
} from '../environment-form'

const full: EnvironmentConfig = {
  id: 'orders-test',
  name: 'Orders test',
  classification: 'TEST',
  limits: { maxStepTimeoutSeconds: 120, maxSuiteConcurrency: 2 },
  values: { region: 'eu', retries: 3, verbose: true },
  targets: {
    api: {
      kind: 'http',
      baseUrl: 'https://example.azure-api.net',
      allowedPaths: ['/orders/*', '/health'],
      allowedMethods: ['GET', 'POST'],
      authentication: {
        type: 'secretReference',
        provider: 'keyVault',
        name: 'orders-api-key',
        usage: 'apiKey',
      },
      correlationHeaders: false,
    },
    storage: {
      kind: 'azureBlob',
      accountUrl: 'https://example.blob.core.windows.net',
      allowedContainers: ['inbound-orders'],
      allowedOperations: ['upload'],
      allowedBlobPrefixes: ['runs/'],
    },
    events: {
      kind: 'azureServiceBus',
      fullyQualifiedNamespace: 'example.servicebus.windows.net',
      allowedEntities: ['order-events'],
      allowedOperations: ['send', 'inspect'],
      credential: {
        type: 'secretReference',
        provider: 'localPlainText',
        name: 'bus-conn',
        usage: 'connectionString',
      },
    },
  },
}

describe('Environment form model', () => {
  it('round-trips a full Environment without losing or inventing anything', () => {
    expect(fromDraft(toDraft(full))).toEqual(full)
  })

  it('drops empty optional fields so the saved file stays tidy', () => {
    const draft = blankEnvironment()
    draft.id = ' orders-dev '
    draft.name = ' Orders dev '
    draft.limits = { maxRetryAttempts: '', maxSuiteSize: ' 5 ' }
    draft.values = [{ uid: 1, key: '', value: 'ignored' }]
    const api = blankTarget('http')
    api.name = 'api'
    api.baseUrl = ' https://example.azure-api.net '
    api.allowedPaths = ' /a \n\n /b\r\n'
    api.secret = { type: 'secretReference', provider: 'keyVault', name: '  ' }
    draft.targets = [api]
    expect(fromDraft(draft)).toEqual({
      id: 'orders-dev',
      name: 'Orders dev',
      classification: 'TEST',
      limits: { maxSuiteSize: 5 },
      targets: {
        api: { kind: 'http', baseUrl: 'https://example.azure-api.net', allowedPaths: ['/a', '/b'] },
      },
    })
  })

  it('keeps the type of a value unless its text was edited', () => {
    const draft = toDraft(full)
    draft.values.find((row) => row.key === 'retries')!.value = '4'
    draft.values.find((row) => row.key === 'verbose')!.value = 'false'
    expect(fromDraft(draft).values).toEqual({ region: 'eu', retries: '4', verbose: 'false' })
  })

  it('turns the Phase 1 secretRef and namespace fields into the current form', () => {
    const draft = toDraft({
      ...full,
      targets: {
        api: {
          kind: 'http',
          baseUrl: 'https://a.example.com',
          allowedPaths: ['/x'],
          secretRef: 'legacy-key',
        },
        bus: { kind: 'azureServiceBus', namespace: 'tiny', allowedEntities: ['q'] },
      },
    })
    expect(fromDraft(draft).targets).toEqual({
      api: {
        kind: 'http',
        baseUrl: 'https://a.example.com',
        allowedPaths: ['/x'],
        authentication: { type: 'secretReference', provider: 'localPlainText', name: 'legacy-key' },
      },
      bus: { kind: 'azureServiceBus', fullyQualifiedNamespace: 'tiny', allowedEntities: ['q'] },
    })
  })

  it('never carries a secret value: a reference holds only provider, name and usage', () => {
    const json = JSON.stringify(fromDraft(toDraft(full)))
    expect(
      Object.keys(
        (fromDraft(toDraft(full)).targets.events as { credential: object }).credential,
      ).sort(),
    ).toEqual(['name', 'provider', 'type', 'usage'])
    expect(json).not.toMatch(/"value"/)
  })
})

describe('draft checks', () => {
  const valid = () => toDraft(full)

  it('accepts a complete draft', () => {
    expect(draftIssues(valid(), { isNew: true })).toEqual([])
  })

  it('checks the id (only for a new Environment), name, target names and limits', () => {
    const draft = valid()
    draft.id = 'Bad Id'
    draft.name = ' '
    draft.targets[1]!.name = 'api'
    draft.targets[2]!.name = 'no spaces'
    draft.limits.maxRetryAttempts = '0'
    const paths = draftIssues(draft, { isNew: true }).map((issue) => issue.path)
    expect(paths).toEqual(['/id', '/name', '/targets', '/targets', '/limits/maxRetryAttempts'])
    expect(draftIssues(draft, { isNew: false }).map((issue) => issue.path)).not.toContain('/id')
  })

  it('refuses local plain-text references for STAGING and PRODUCTION', () => {
    const draft = valid()
    draft.classification = 'PRODUCTION'
    const issues = draftIssues(draft, { isNew: false })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.message).toContain('Key Vault')
    expect(allowsPlainText('PRODUCTION')).toBe(false)
    expect(allowsPlainText('STAGING')).toBe(false)
    expect(allowsPlainText('TEST')).toBe(true)
    expect(allowsPlainText('LOCAL')).toBe(true)
  })

  it('helpers', () => {
    expect(linesToArray('a\n\n b \r\nc')).toEqual(['a', 'b', 'c'])
    expect(targetOfIssue('/targets/orders-api/baseUrl')).toBe('orders-api')
    expect(targetOfIssue('/name')).toBeUndefined()
  })
})
