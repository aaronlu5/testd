import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BREAKPOINT_DEFAULTS,
  BREAKPOINT_MESSAGE_MAX_LENGTH,
  ERROR_CODES,
  KEY_VAULT_SECRET_NAME_PATTERN,
  LOCAL_SECRET_NAME_PATTERN,
  RUN_STATUSES,
  STEP_RUN_STATUSES,
  SUITE_RUN_ITEM_STATUSES,
  SUITE_RUN_STATUSES,
  TEST_SCHEMA_VERSION,
  findInlineSecrets,
  looksLikeSecretValue,
  upgradeTestToCurrentSchema,
  validateBreakpointParameters,
  validateEnvironment,
  validateRun,
  validateRunEvent,
  validateSuite,
  validateTest,
  type TestDefinition,
} from '../src/index.js';

const fixtures = join(import.meta.dirname, '..', 'fixtures');
const load = <T>(kind: 'valid' | 'invalid', file: string): T =>
  JSON.parse(readFileSync(join(fixtures, kind, file), 'utf8')) as T;

const SB_CONNECTION =
  'Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=send;SharedAccessKey=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==';

describe('Phase 2 enumerations', () => {
  it('adds Paused without disturbing existing members', () => {
    expect(RUN_STATUSES).toEqual([
      'Queued',
      'Running',
      'Paused',
      'Cancelling',
      'Succeeded',
      'Failed',
      'Cancelled',
    ]);
    expect(STEP_RUN_STATUSES).toContain('Paused');
    for (const status of [
      'Queued',
      'Running',
      'Succeeded',
      'Failed',
      'Retrying',
      'Skipped',
      'Cancelled',
    ])
      expect(STEP_RUN_STATUSES).toContain(status);
    expect(SUITE_RUN_STATUSES).toContain('WaitingForBreakpoint');
    expect(SUITE_RUN_ITEM_STATUSES).toEqual(
      expect.arrayContaining(['Pending', 'Paused', 'Skipped']),
    );
  });

  it('adds stable pause and secret error codes', () => {
    for (const code of [
      'EXECUTION_NOT_PAUSED',
      'EXECUTION_STALE_CONTINUATION',
      'EXECUTION_BREAKPOINT_CONTEXT_CHANGED',
      'VALIDATION_SECRET_REFERENCE',
      'VALIDATION_INLINE_SECRET',
      'AUTH_SECRET_UNAVAILABLE',
    ])
      expect(ERROR_CODES).toContain(code);
  });
});

describe('Breakpoint Step parameters', () => {
  it('accepts enabled with an optional message and no other property', () => {
    expect(validateBreakpointParameters({ enabled: true }).valid).toBe(true);
    expect(validateBreakpointParameters({ enabled: false, message: 'Look here' }).valid).toBe(true);
    expect(validateBreakpointParameters(BREAKPOINT_DEFAULTS).valid).toBe(true);
    expect(
      validateBreakpointParameters({
        enabled: true,
        message: 'x'.repeat(BREAKPOINT_MESSAGE_MAX_LENGTH),
      }).valid,
    ).toBe(true);
  });

  it('rejects missing, mistyped, oversized and extra parameters', () => {
    const issues = (value: unknown) => {
      const result = validateBreakpointParameters(value);
      return result.valid ? [] : result.issues;
    };
    expect(issues({})[0]).toMatchObject({ path: '/enabled', keyword: 'required' });
    expect(issues({ enabled: 'true' })[0]).toMatchObject({ path: '/enabled', keyword: 'type' });
    expect(issues({ enabled: true, message: 5 })[0]).toMatchObject({ path: '/message' });
    expect(
      issues({ enabled: true, message: 'x'.repeat(BREAKPOINT_MESSAGE_MAX_LENGTH + 1) })[0],
    ).toMatchObject({ path: '/message', keyword: 'maxLength' });
    // No target, secret or executable parameter is permitted.
    for (const extra of ['target', 'secret', 'script', 'command'])
      expect(issues({ enabled: true, [extra]: 'x' })[0]).toMatchObject({
        path: `/${extra}`,
        keyword: 'additionalProperties',
      });
  });
});

describe('Test schema versions and editor metadata', () => {
  it('still accepts a Phase 1 (version 1) Test with no editor settings', () => {
    const legacy = load<Record<string, unknown>>('valid', 'test.json');
    expect(legacy.schemaVersion).toBe(1);
    expect(validateTest(legacy).valid).toBe(true);
  });

  it('accepts positions, edge metadata and editor settings on version 2', () => {
    expect(validateTest(load('valid', 'test--position-sequenced.json')).valid).toBe(true);
  });

  it('allows positions on a version 1 Test (they are inert without editor settings)', () => {
    const legacy = load<TestDefinition>('valid', 'test.json');
    const withPosition = {
      ...legacy,
      nodes: legacy.nodes.map((node, index) => ({ ...node, position: { x: 0, y: index * 10 } })),
    };
    expect(validateTest(withPosition).valid).toBe(true);
  });

  it('rejects unknown editor and edge metadata properties', () => {
    const test = load<TestDefinition>('valid', 'test--position-sequenced.json');
    expect(validateTest({ ...test, editor: { ...test.editor, theme: 'dark' } }).valid).toBe(false);
    expect(
      validateTest({ ...test, edges: [{ from: 'wait', to: 'inspect', metadata: { owner: 'me' } }] })
        .valid,
    ).toBe(false);
    expect(
      validateTest({
        ...test,
        nodes: [{ ...test.nodes[0], position: { x: 0, y: 0, z: 1 } }, ...test.nodes.slice(1)],
      }).valid,
    ).toBe(false);
  });

  it('accepts a Suite maxConcurrency but not an out-of-range one', () => {
    const suite = load<Record<string, unknown>>('valid', 'suite.json');
    expect(validateSuite({ ...suite, maxConcurrency: 3 }).valid).toBe(true);
    expect(validateSuite({ ...suite, maxConcurrency: 0 }).valid).toBe(false);
    expect(validateSuite({ ...suite, maxConcurrency: 1.5 }).valid).toBe(false);
  });
});

describe('upgradeTestToCurrentSchema (pure v1 -> v2 migration)', () => {
  const legacy = (): TestDefinition => load<TestDefinition>('valid', 'test.json');

  it('adds editor settings with sequencing disabled and changes nothing else', () => {
    const before = legacy();
    const snapshot = JSON.stringify(before);
    const after = upgradeTestToCurrentSchema(before);

    expect(JSON.stringify(before)).toBe(snapshot); // input is not mutated
    expect(after.schemaVersion).toBe(TEST_SCHEMA_VERSION);
    expect(after.editor).toEqual({ layoutDirection: 'vertical', autoSequenceFromPosition: false });

    const strip = (test: TestDefinition): Record<string, unknown> => {
      const copy: Record<string, unknown> = { ...test };
      delete copy.schemaVersion;
      delete copy.editor;
      return copy;
    };
    const rest = strip(after);
    const original = strip(before);
    expect(rest).toEqual(original); // id, version, metadata, nodes, edges, variables preserved
    expect(after.edges).toEqual(before.edges);
    expect(validateTest(after).valid).toBe(true);
  });

  it('is idempotent and leaves current-schema Tests untouched', () => {
    const once = upgradeTestToCurrentSchema(legacy());
    expect(upgradeTestToCurrentSchema(once)).toBe(once);
    const current = load<TestDefinition>('valid', 'test--position-sequenced.json');
    expect(upgradeTestToCurrentSchema(current)).toBe(current);
  });

  it('does not share editor state between upgraded Tests', () => {
    const a = upgradeTestToCurrentSchema(legacy());
    const b = upgradeTestToCurrentSchema(legacy());
    expect(a.editor).not.toBe(b.editor);
  });
});

describe('typed secret references', () => {
  type Env = { environments: { targets: Record<string, Record<string, unknown>> }[] };
  const base = (): Env => load<Env>('valid', 'environments--azure-secret-references.json');
  const environment = (target: Record<string, unknown>) => ({
    ...base().environments[0],
    targets: { t: target },
  });

  it('accepts keyVault and localPlainText references with usage', () => {
    expect(validateEnvironment(base().environments[0]).valid).toBe(true);
  });

  it('still accepts the Phase 1 secretRef string and namespace field', () => {
    expect(
      validateEnvironment(
        environment({
          kind: 'http',
          baseUrl: 'https://example.test',
          allowedPaths: ['/'],
          secretRef: 'example-api-key',
        }),
      ).valid,
    ).toBe(true);
    expect(
      validateEnvironment(
        environment({
          kind: 'azureServiceBus',
          namespace: 'example.invalid',
          allowedEntities: ['q'],
        }),
      ).valid,
    ).toBe(true);
  });

  it('has no place for a secret value on any target or reference', () => {
    const reference = { type: 'secretReference', provider: 'localPlainText', name: 'orders-sb' };
    const http = { kind: 'http', baseUrl: 'https://example.test', allowedPaths: ['/'] };
    for (const [label, target] of Object.entries({
      'value on reference': { ...http, authentication: { ...reference, value: 'x' } },
      'secret on reference': { ...http, authentication: { ...reference, secret: 'x' } },
      'inline apiKey': { ...http, apiKey: 'abc' },
      'inline connectionString': {
        kind: 'azureServiceBus',
        fullyQualifiedNamespace: 'example.servicebus.windows.net',
        allowedEntities: ['q'],
        connectionString: SB_CONNECTION,
      },
      'string instead of reference': { ...http, authentication: 'abc' },
      'wrong type tag': { ...http, authentication: { ...reference, type: 'inlineSecret' } },
    })) {
      expect(validateEnvironment(environment(target)).valid, label).toBe(false);
    }
  });

  it('requires an explicit provider and a name valid for that provider', () => {
    const http = { kind: 'http', baseUrl: 'https://example.test', allowedPaths: ['/'] };
    const ok = (authentication: unknown) =>
      validateEnvironment(environment({ ...http, authentication })).valid;
    expect(ok({ type: 'secretReference', provider: 'keyVault', name: 'orders-api-key' })).toBe(
      true,
    );
    expect(ok({ type: 'secretReference', name: 'orders-api-key' })).toBe(false); // no implicit provider
    expect(ok({ type: 'secretReference', provider: 'environment', name: 'x' })).toBe(false);
    expect(ok({ type: 'secretReference', provider: 'keyVault', name: 'under_score' })).toBe(false);
    expect(
      ok({
        type: 'secretReference',
        provider: 'keyVault',
        name: 'http://insecure.vault.azure.net/secrets/x',
      }),
    ).toBe(false);
    expect(
      ok({ type: 'secretReference', provider: 'localPlainText', name: '9starts-with-digit' }),
    ).toBe(false);
    expect(ok({ type: 'secretReference', provider: 'localPlainText', name: 'a'.repeat(65) })).toBe(
      false,
    );
    expect(
      ok({ type: 'secretReference', provider: 'keyVault', name: 'k', usage: 'password' }),
    ).toBe(true);
    expect(
      ok({ type: 'secretReference', provider: 'keyVault', name: 'k', usage: 'plaintext' }),
    ).toBe(false);
  });

  it('exposes the name patterns used by the providers', () => {
    expect(new RegExp(LOCAL_SECRET_NAME_PATTERN).test('orders-service-bus-connection')).toBe(true);
    expect(new RegExp(KEY_VAULT_SECRET_NAME_PATTERN).test('orders-api-key')).toBe(true);
    expect(
      new RegExp(KEY_VAULT_SECRET_NAME_PATTERN).test(
        `https://orders-kv.vault.azure.net/secrets/orders-api-key/${'a'.repeat(32)}`,
      ),
    ).toBe(true);
  });

  it('caps Suite concurrency in the Environment schema', () => {
    const limits = (maxSuiteConcurrency: number) =>
      validateEnvironment({ ...base().environments[0], limits: { maxSuiteConcurrency } }).valid;
    expect(limits(4)).toBe(true);
    expect(limits(0)).toBe(false);
  });
});

describe('inline secret detection', () => {
  it('detects connection strings, SAS signatures and private keys by shape', () => {
    for (const value of [
      SB_CONNECTION,
      'DefaultEndpointsProtocol=https;AccountName=a;AccountKey=Zm9vYmFyYmF6cXV4MTIz;EndpointSuffix=core.windows.net',
      'https://a.blob.core.windows.net/c/b?sv=2022-11-02&sig=abcdefghijklmnopqrstuvwxyz%2F12',
      '-----BEGIN RSA PRIVATE KEY-----\nabc',
    ])
      expect(looksLikeSecretValue(value), value).toBe(true);
  });

  it('leaves ordinary values alone', () => {
    for (const value of [
      'ORD-10001',
      'Endpoint=sb://example.servicebus.windows.net/',
      'a password policy',
      '{{testData.order.id}}',
      'https://example.test/orders?sig=short',
    ])
      expect(looksLikeSecretValue(value), value).toBe(false);
  });

  it('reports JSON pointers, never the matched text', () => {
    const findings = findInlineSecrets({
      body: { note: SB_CONNECTION, list: ['ok', SB_CONNECTION] },
      'a/b': { c: SB_CONNECTION },
    });
    expect(findings.map((f) => f.path)).toEqual(['/body/note', '/body/list/1', '/a~1b/c']);
    expect(JSON.stringify(findings)).not.toContain('Zm9vYmFy');
  });

  it('flags secret-carrying parameter names only for literals, only when asked', () => {
    const params = {
      inlineSecret: 'hunter2hunter2',
      connectionString: '{{environment.cs}}',
      other: 'x',
    };
    expect(findInlineSecrets(params)).toEqual([]);
    expect(findInlineSecrets(params, { rejectSecretKeys: true })).toEqual([
      { path: '/inlineSecret', reason: 'inline-secret-key' },
    ]);
    expect(
      findInlineSecrets({ nested: { accountKey: 'abcdefgh' } }, { rejectSecretKeys: true }, '/p'),
    ).toEqual([{ path: '/p/nested/accountKey', reason: 'inline-secret-key' }]);
  });

  it('terminates on deeply nested values', () => {
    let deep: Record<string, unknown> = { leaf: SB_CONNECTION };
    for (let i = 0; i < 100; i += 1) deep = { child: deep };
    expect(() => findInlineSecrets(deep as never)).not.toThrow();
  });
});

describe('Run and event contracts for pauses', () => {
  it('accepts a paused Run and omits generation 0 for Phase 1 Runs', () => {
    expect(validateRun(load('valid', 'run--paused.json')).valid).toBe(true);
    expect(validateRun(load('valid', 'run.json')).valid).toBe(true);
  });

  it('rejects a negative continuation generation', () => {
    const run = load<Record<string, unknown>>('valid', 'run--paused.json');
    expect(validateRun({ ...run, continuationGeneration: -1 }).valid).toBe(false);
  });

  it('validates every new event type and rejects malformed payloads', () => {
    for (const file of [
      'run-event--paused.json',
      'run-event--resumed.json',
      'run-event--cancelled.json',
      'run-event--step-updated.json',
    ])
      expect(validateRunEvent(load('valid', file)).valid, file).toBe(true);

    const resumed = load<{ data: Record<string, unknown> }>('valid', 'run-event--resumed.json');
    expect(
      validateRunEvent({ ...resumed, data: { ...resumed.data, continuationGeneration: 0 } }).valid,
    ).toBe(false); // a resume always moves to generation >= 1
    expect(validateRunEvent({ ...resumed, data: { ...resumed.data, secret: 'x' } }).valid).toBe(
      false,
    );
  });
});
