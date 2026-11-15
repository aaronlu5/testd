import { describe, expect, it } from 'vitest';
import type { SuiteRunCounts, TestDefinition } from '@test-platform/contracts';
import {
  REDACTED,
  activeSuiteItemCount,
  assertRunTransition,
  assertStepRunTransition,
  availableDispatchSlots,
  collectSecretReferences,
  comparePositioned,
  countSuiteItems,
  decideResume,
  decideRunTransition,
  decideStepRunTransition,
  decideSuiteItemTransition,
  decideSuiteRunTransition,
  deriveSuiteRunStatus,
  describeReorder,
  effectiveSuiteConcurrency,
  generateSequentialEdges,
  isPausedRunStatus,
  isPositionManaged,
  isTerminalRunStatus,
  isTerminalStepRunStatus,
  isTerminalSuiteItemStatus,
  isTerminalSuiteRunStatus,
  legacySecretReference,
  normalizeTestLayout,
  redactText,
  redactValue,
  sortNodesByPosition,
  validatePositionSequence,
  validateTestDefinition,
} from '../src/index.js';

const known = (type: string) => ['delay', 'assert', 'breakpoint'].includes(type);

const node = (id: string, y: number | undefined, x = 0, type = 'delay') => ({
  id,
  type,
  name: id,
  parameters:
    type === 'delay' ? { durationSeconds: 1 } : type === 'breakpoint' ? { enabled: true } : {},
  ...(y === undefined ? {} : { position: { x, y } }),
});

const makeTest = (overrides: Record<string, unknown> = {}): TestDefinition =>
  ({
    schemaVersion: 2,
    id: '01JTEST8M2B5D4KQ7XNH3WV9ZA',
    version: 1,
    name: 'Sequenced',
    tags: [],
    metadata: { createdAt: '2026-01-15T09:30:00.000Z', createdBy: 'tester' },
    variables: {},
    editor: { layoutDirection: 'vertical', autoSequenceFromPosition: true },
    nodes: [node('a', 0), node('b', 100), node('c', 200)],
    edges: [
      { from: 'a', to: 'b', metadata: { systemManaged: true } },
      { from: 'b', to: 'c', metadata: { systemManaged: true } },
    ],
    ...overrides,
  }) as unknown as TestDefinition;

describe('Paused state transitions', () => {
  it('pauses only from Running and resumes or cancels only from Paused', () => {
    expect(decideRunTransition('Running', 'Paused')).toBe('apply');
    expect(decideRunTransition('Paused', 'Queued')).toBe('apply');
    expect(decideRunTransition('Paused', 'Cancelled')).toBe('apply');
    for (const from of ['Queued', 'Cancelling', 'Succeeded', 'Failed', 'Cancelled'] as const)
      expect(decideRunTransition(from, 'Paused')).toBe('reject');
    for (const to of ['Running', 'Succeeded', 'Failed', 'Cancelling'] as const)
      expect(decideRunTransition('Paused', to)).toBe('reject');
    expect(decideRunTransition('Paused', 'Paused')).toBe('noop');
    expect(() => assertRunTransition('Queued', 'Paused')).toThrow('cannot move');
  });

  it('treats Paused as active, not terminal, with no lease implied', () => {
    expect(isTerminalRunStatus('Paused')).toBe(false);
    expect(isPausedRunStatus('Paused')).toBe(true);
    expect(isPausedRunStatus('Running')).toBe(false);
  });

  it('models the Breakpoint Step Run: Running -> Paused -> Succeeded', () => {
    expect(decideStepRunTransition('Running', 'Paused')).toBe('apply');
    expect(decideStepRunTransition('Paused', 'Succeeded')).toBe('apply');
    expect(decideStepRunTransition('Paused', 'Cancelled')).toBe('apply');
    expect(decideStepRunTransition('Paused', 'Failed')).toBe('reject');
    expect(decideStepRunTransition('Paused', 'Running')).toBe('reject');
    expect(decideStepRunTransition('Queued', 'Paused')).toBe('reject');
    expect(isTerminalStepRunStatus('Paused')).toBe(false);
    expect(() => assertStepRunTransition('Succeeded', 'Paused')).toThrow();
    // A disabled Breakpoint records Skipped without ever running.
    expect(decideStepRunTransition('Queued', 'Skipped')).toBe('apply');
  });

  it('keeps every Phase 1 transition unchanged', () => {
    expect(decideRunTransition('Queued', 'Running')).toBe('apply');
    expect(decideRunTransition('Running', 'Queued')).toBe('apply');
    expect(decideRunTransition('Succeeded', 'Running')).toBe('reject');
    expect(decideStepRunTransition('Running', 'Retrying')).toBe('apply');
  });
});

describe('resume guards', () => {
  const base = { currentGeneration: 0 };
  it('resumes the active pause, or the one the caller inspected', () => {
    expect(decideResume({ ...base, runStatus: 'Paused', activePauseGeneration: 0 })).toEqual({
      kind: 'resume',
    });
    expect(
      decideResume({
        ...base,
        runStatus: 'Paused',
        activePauseGeneration: 0,
        expectedGeneration: 0,
      }),
    ).toEqual({ kind: 'resume' });
  });

  it('flags a stale generation', () => {
    expect(
      decideResume({
        currentGeneration: 1,
        runStatus: 'Paused',
        activePauseGeneration: 1,
        expectedGeneration: 0,
      }),
    ).toEqual({ kind: 'stale' });
  });

  it('treats a repeat of an already resumed generation as a duplicate', () => {
    expect(
      decideResume({
        currentGeneration: 1,
        runStatus: 'Queued',
        expectedGeneration: 0,
        expectedGenerationResumed: true,
      }),
    ).toEqual({ kind: 'duplicate' });
    // ...but not when the Run has moved on by more than one continuation, or was never resumed.
    expect(
      decideResume({
        currentGeneration: 2,
        runStatus: 'Running',
        expectedGeneration: 0,
        expectedGenerationResumed: true,
      }),
    ).toEqual({ kind: 'not-paused' });
    expect(decideResume({ ...base, runStatus: 'Running' })).toEqual({ kind: 'not-paused' });
    expect(decideResume({ ...base, runStatus: 'Cancelled', expectedGeneration: 0 })).toEqual({
      kind: 'not-paused',
    });
  });
});

describe('position-driven sequencing', () => {
  it('orders by y, then x, then node id', () => {
    expect(sortNodesByPosition([node('c', 10), node('a', 30), node('b', 20)])).toEqual([
      'c',
      'b',
      'a',
    ]);
    // Equal y: x decides.
    expect(sortNodesByPosition([node('a', 10, 50), node('b', 10, 5)])).toEqual(['b', 'a']);
    // Equal y and x: id is the stable tie-breaker, regardless of input order.
    expect(sortNodesByPosition([node('z', 10, 5), node('m', 10, 5), node('b', 10, 5)])).toEqual([
      'b',
      'm',
      'z',
    ]);
    expect(sortNodesByPosition([node('b', 10, 5), node('z', 10, 5), node('m', 10, 5)])).toEqual([
      'b',
      'm',
      'z',
    ]);
  });

  it('compares ids by code unit, independent of locale, and handles negatives', () => {
    expect(comparePositioned({ id: 'B' }, { id: 'a' })).toBeLessThan(0); // 'B' < 'a'
    expect(sortNodesByPosition([node('a', -10), node('b', -20), node('c', 0)])).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('does not mutate its input', () => {
    const nodes = [node('b', 20), node('a', 10)];
    sortNodesByPosition(nodes);
    expect(nodes.map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('generates one system-managed edge between each adjacent pair', () => {
    expect(generateSequentialEdges(['a', 'b', 'c'])).toEqual([
      { from: 'a', to: 'b', metadata: { systemManaged: true } },
      { from: 'b', to: 'c', metadata: { systemManaged: true } },
    ]);
    expect(generateSequentialEdges(['only'])).toEqual([]);
    expect(generateSequentialEdges([])).toEqual([]);
  });

  it('reorders when a node is moved above another and reconnects every pair', () => {
    const test = makeTest({ nodes: [node('a', 0), node('b', 100), node('c', -50)] });
    const result = normalizeTestLayout(test);
    expect(result.order).toEqual(['c', 'a', 'b']);
    expect(result.test.edges).toEqual([
      { from: 'c', to: 'a', metadata: { systemManaged: true } },
      { from: 'a', to: 'b', metadata: { systemManaged: true } },
    ]);
    expect(result).toMatchObject({ edgesChanged: true, orderChanged: true, issues: [] });
    expect(test.edges).toHaveLength(2); // input untouched
    expect(test.edges[0]).toMatchObject({ from: 'a', to: 'b' });
  });

  it('reports no change when edges already match, and replaces hand-drawn edges', () => {
    const same = normalizeTestLayout(makeTest());
    expect(same).toMatchObject({
      edgesChanged: false,
      orderChanged: false,
      order: ['a', 'b', 'c'],
    });

    const manual = normalizeTestLayout(
      makeTest({
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
        ],
      }),
    );
    expect(manual.orderChanged).toBe(false);
    expect(manual.edgesChanged).toBe(true); // same pairs, but now system-managed
    expect(manual.test.edges.every((e) => e.metadata?.systemManaged)).toBe(true);

    const dropped = normalizeTestLayout(makeTest({ edges: [] }));
    expect(dropped.edgesChanged).toBe(true);
    expect(dropped.test.edges).toHaveLength(2);
  });

  it('is idempotent', () => {
    const once = normalizeTestLayout(makeTest({ nodes: [node('a', 5), node('b', 1)], edges: [] }));
    const twice = normalizeTestLayout(once.test);
    expect(twice.test).toEqual(once.test);
    expect(twice).toMatchObject({ edgesChanged: false, orderChanged: false });
  });

  it('supports legacy Tests with sequencing disabled or no editor settings', () => {
    const legacy = makeTest({
      schemaVersion: 1,
      editor: undefined,
      nodes: [node('a', undefined), node('b', undefined)],
      edges: [{ from: 'b', to: 'a' }],
    });
    expect(isPositionManaged(legacy)).toBe(false);
    const result = normalizeTestLayout(legacy);
    expect(result.test).toBe(legacy);
    expect(result).toMatchObject({ order: ['b', 'a'], edgesChanged: false, orderChanged: false });
    expect(validatePositionSequence(legacy)).toEqual([]);

    // Positions that disagree with the edges are ignored when sequencing is off.
    const disabled = makeTest({
      editor: { layoutDirection: 'vertical', autoSequenceFromPosition: false },
      nodes: [node('a', 300), node('b', 0)],
      edges: [{ from: 'a', to: 'b' }],
    });
    expect(validatePositionSequence(disabled)).toEqual([]);
    expect(normalizeTestLayout(disabled).order).toEqual(['a', 'b']);
  });

  it('rejects missing or non-numeric positions in position-managed Tests', () => {
    const missing = makeTest({ nodes: [node('a', 0), node('b', undefined)] });
    expect(validatePositionSequence(missing)).toMatchObject([
      { code: 'FLOW_POSITION_INVALID', nodeIds: ['b'] },
    ]);
    const nan = makeTest({ nodes: [{ ...node('a', 0), position: { x: 0, y: Number.NaN } }] });
    expect(validatePositionSequence(nan)).toMatchObject([{ code: 'FLOW_POSITION_INVALID' }]);
    expect(normalizeTestLayout(missing)).toMatchObject({
      order: [],
      issues: [{ code: 'FLOW_POSITION_INVALID' }],
    });
  });

  it('flags edges that disagree with positions', () => {
    const wrong = makeTest({
      edges: [
        { from: 'b', to: 'a' },
        { from: 'a', to: 'c' },
      ],
    });
    expect(validatePositionSequence(wrong)).toMatchObject([{ code: 'FLOW_EDGES_MISMATCH' }]);
    expect(validatePositionSequence(makeTest())).toEqual([]);
    // Edge order in the array is irrelevant.
    const shuffled = makeTest({
      edges: [
        { from: 'b', to: 'c' },
        { from: 'a', to: 'b' },
      ],
    });
    expect(validatePositionSequence(shuffled)).toEqual([]);
  });

  it('describes reorders for accessible announcements', () => {
    expect(describeReorder(['a', 'b', 'c'], ['a', 'c', 'b'], (id) => `Step ${id}`)).toEqual([
      'Step c moved from position 3 to position 2; connections updated.',
      'Step b moved from position 2 to position 3; connections updated.',
    ]);
    expect(describeReorder(['a', 'b'], ['a', 'b'])).toEqual([]);
  });
});

describe('validateTestDefinition (Phase 2)', () => {
  it('accepts a position-managed Test and derives its order', () => {
    expect(validateTestDefinition(makeTest(), { isKnownStepType: known })).toEqual({
      valid: true,
      issues: [],
      order: ['a', 'b', 'c'],
    });
  });

  it('rejects an edge list that differs from the one implied by positions', () => {
    const result = validateTestDefinition(
      makeTest({
        edges: [
          { from: 'a', to: 'c' },
          { from: 'c', to: 'b' },
        ],
      }),
      { isKnownStepType: known },
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.keyword)).toContain('FLOW_EDGES_MISMATCH');
  });

  it('still enforces the Phase 1 graph rules after generation', () => {
    const duplicate = validateTestDefinition(
      makeTest({ nodes: [node('a', 0), node('a', 10)], edges: [] }),
      { isKnownStepType: known },
    );
    expect(duplicate.valid).toBe(false);
    expect(duplicate.issues.map((i) => i.keyword)).toContain('FLOW_DUPLICATE_NODE');
  });

  it('keeps validating legacy Tests by their stored edges only', () => {
    const legacy = makeTest({
      schemaVersion: 1,
      editor: undefined,
      nodes: [node('a', undefined), node('b', undefined)],
      edges: [{ from: 'a', to: 'b' }],
    });
    expect(validateTestDefinition(legacy, { isKnownStepType: known })).toMatchObject({
      valid: true,
      order: ['a', 'b'],
    });
  });

  it('requires editor settings on schema version 2', () => {
    const result = validateTestDefinition(makeTest({ editor: undefined }));
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.keyword).toBe('required');
  });

  it('validates Breakpoint parameters', () => {
    const withBreakpoint = (parameters: unknown) =>
      makeTest({
        nodes: [
          node('a', 0),
          { id: 'bp', type: 'breakpoint', name: 'Inspect', parameters, position: { x: 0, y: 100 } },
        ],
        edges: [{ from: 'a', to: 'bp', metadata: { systemManaged: true } }],
      });
    expect(
      validateTestDefinition(withBreakpoint({ enabled: true, message: 'Check it' }), {
        isKnownStepType: known,
      }).valid,
    ).toBe(true);
    expect(
      validateTestDefinition(withBreakpoint({ enabled: false }), { isKnownStepType: known }).valid,
    ).toBe(true);

    for (const bad of [
      {},
      { enabled: 'yes' },
      { enabled: true, message: 'x'.repeat(1001) },
      {
        enabled: true,
        target: 'orders-api',
      },
    ]) {
      const result = validateTestDefinition(withBreakpoint(bad), { isKnownStepType: known });
      expect(result.valid).toBe(false);
      expect(result.issues[0]?.path).toMatch(/^\/nodes\/1\/parameters/);
    }
  });

  it('rejects inline secrets without echoing them', () => {
    const connection =
      'Endpoint=sb://example.servicebus.windows.net/;SharedAccessKey=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==';
    const result = validateTestDefinition(
      makeTest({
        variables: { sb: connection },
        nodes: [{ ...node('a', 0), parameters: { inlineSecret: 'hunter2hunter2' } }],
        edges: [],
      }),
      { isKnownStepType: known },
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.keyword)).toEqual([
      'VALIDATION_INLINE_SECRET',
      'VALIDATION_INLINE_SECRET',
    ]);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('Zm9vYmFy');
  });
});

describe('Suite Run rules', () => {
  const counts = (partial: Partial<SuiteRunCounts>): SuiteRunCounts => ({
    ...countSuiteItems([]),
    ...partial,
    total:
      partial.total ??
      Object.entries(partial).reduce(
        (sum, [key, n]) => (key === 'total' ? sum : sum + (n ?? 0)),
        0,
      ),
  });

  it('transitions parents and children with guards', () => {
    expect(decideSuiteRunTransition('Queued', 'Running')).toBe('apply');
    expect(decideSuiteRunTransition('Running', 'WaitingForBreakpoint')).toBe('apply');
    expect(decideSuiteRunTransition('WaitingForBreakpoint', 'Running')).toBe('apply');
    expect(decideSuiteRunTransition('Succeeded', 'Running')).toBe('reject');
    expect(decideSuiteRunTransition('Cancelling', 'Succeeded')).toBe('reject');
    expect(isTerminalSuiteRunStatus('Failed')).toBe(true);
    expect(isTerminalSuiteRunStatus('WaitingForBreakpoint')).toBe(false);

    expect(decideSuiteItemTransition('Pending', 'Queued')).toBe('apply');
    expect(decideSuiteItemTransition('Running', 'Paused')).toBe('apply');
    expect(decideSuiteItemTransition('Paused', 'Queued')).toBe('apply');
    expect(decideSuiteItemTransition('Pending', 'Running')).toBe('reject');
    expect(decideSuiteItemTransition('Succeeded', 'Running')).toBe('reject');
    expect(isTerminalSuiteItemStatus('Skipped')).toBe(true);
    expect(isTerminalSuiteItemStatus('Paused')).toBe(false);
  });

  it('counts paused children against the concurrency limit', () => {
    const c = counts({ Pending: 3, Running: 1, Paused: 1 });
    expect(activeSuiteItemCount(c)).toBe(2);
    expect(availableDispatchSlots(c, 2)).toBe(0);
    expect(availableDispatchSlots(c, 3)).toBe(1);
    expect(availableDispatchSlots(counts({ Pending: 1 }), 5)).toBe(1);
    expect(availableDispatchSlots(counts({ Pending: 0, Running: 1 }), 5)).toBe(0);
  });

  it('derives the parent status from its children', () => {
    const started = { cancelRequested: false, started: true };
    expect(
      deriveSuiteRunStatus(counts({ Pending: 2 }), { cancelRequested: false, started: false }),
    ).toBe('Queued');
    expect(deriveSuiteRunStatus(counts({ Pending: 1, Running: 1 }), started)).toBe('Running');
    expect(deriveSuiteRunStatus(counts({ Pending: 1, Paused: 1 }), started)).toBe(
      'WaitingForBreakpoint',
    );
    // A paused child plus a running one keeps the parent Running.
    expect(deriveSuiteRunStatus(counts({ Paused: 1, Running: 1 }), started)).toBe('Running');
    expect(deriveSuiteRunStatus(counts({ Succeeded: 3 }), started)).toBe('Succeeded');
    expect(deriveSuiteRunStatus(counts({ Succeeded: 2, Failed: 1 }), started)).toBe('Failed');
    expect(deriveSuiteRunStatus(counts({ Succeeded: 1, Cancelled: 1 }), started)).toBe('Cancelled');
    expect(
      deriveSuiteRunStatus(counts({ Running: 1, Skipped: 2 }), {
        cancelRequested: true,
        started: true,
      }),
    ).toBe('Cancelling');
    expect(
      deriveSuiteRunStatus(counts({ Cancelled: 1, Skipped: 2 }), {
        cancelRequested: true,
        started: true,
      }),
    ).toBe('Cancelled');
  });

  it('caps requested concurrency by the Environment limit, defaulting to 1', () => {
    expect(effectiveSuiteConcurrency(undefined, undefined)).toBe(1);
    expect(effectiveSuiteConcurrency(4, undefined)).toBe(1);
    expect(effectiveSuiteConcurrency(4, 2)).toBe(2);
    expect(effectiveSuiteConcurrency(1, 8)).toBe(1);
    expect(effectiveSuiteConcurrency(0, 8)).toBe(1);
  });
});

describe('pattern-based redaction', () => {
  const SB_KEY = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==';
  const connection = `Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=send;SharedAccessKey=${SB_KEY}`;

  it('masks connection-string keys, SAS signatures, bearer tokens and private keys', () => {
    const masked = redactText(
      [
        connection,
        `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${SB_KEY};EndpointSuffix=core.windows.net`,
        'Server=db;User Id=u;Password=Sup3rS3cret!;',
        'https://acct.blob.core.windows.net/c/b?sv=2022&sig=abcDEF123%2Fxyz789&se=2030',
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
        '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----',
      ].join('\n'),
    );
    for (const leaked of [SB_KEY, 'Sup3rS3cret', 'abcDEF123', 'eyJhbGci', 'MIIEvQ'])
      expect(masked).not.toContain(leaked);
    expect(masked).toContain('Endpoint=sb://example.servicebus.windows.net/'); // non-secret context survives
    expect(masked).toContain(`SharedAccessKey=${REDACTED}`);
    expect(masked).toContain(`Bearer ${REDACTED}`);
  });

  it('masks nested strings and error messages in structured values', () => {
    const masked = redactValue({
      note: `retry with ${connection}`,
      list: [{ detail: `Password=hunter2hunter2;` }],
      error: new Error(`failed: AccountKey=${SB_KEY}`),
    }) as { note: string; list: { detail: string }[]; error: { message: string } };
    expect(JSON.stringify(masked)).not.toContain(SB_KEY);
    expect(JSON.stringify(masked)).not.toContain('hunter2hunter2');
  });

  it('masks an exact registered connection string wherever it appears', () => {
    const masked = redactText(`using ${connection} for send`, [connection]);
    expect(masked).toBe(`using ${REDACTED} for send`);
  });

  it('can be disabled for callers that need raw text', () => {
    const raw = redactValue(
      { a: connection },
      { maskPatterns: false, maskSensitiveKeys: false },
    ) as {
      a: string;
    };
    expect(raw.a).toBe(connection);
  });

  it('leaves ordinary text alone', () => {
    const text = 'Order ORD-1 uploaded; password policy accepted; Bearer of good news';
    expect(redactText(text)).toBe(text);
  });
});

describe('secret reference collection', () => {
  it('lists typed and legacy references across targets without values', () => {
    const refs = collectSecretReferences({
      targets: {
        api: {
          kind: 'http',
          baseUrl: 'https://example.test',
          allowedPaths: ['/'],
          authentication: { type: 'secretReference', provider: 'keyVault', name: 'orders-api-key' },
        },
        legacy: {
          kind: 'http',
          baseUrl: 'https://example.test',
          allowedPaths: ['/'],
          secretRef: 'old-key',
        },
        events: {
          kind: 'azureServiceBus',
          fullyQualifiedNamespace: 'example.servicebus.windows.net',
          allowedEntities: ['order-events'],
          credential: { type: 'secretReference', provider: 'localPlainText', name: 'orders-sb' },
        },
        blob: {
          kind: 'azureBlob',
          accountUrl: 'https://example.blob.core.windows.net',
          allowedContainers: ['c'],
        },
      },
    });
    expect(refs).toEqual([
      {
        target: 'api',
        reference: { type: 'secretReference', provider: 'keyVault', name: 'orders-api-key' },
      },
      { target: 'legacy', reference: legacySecretReference('old-key') },
      {
        target: 'events',
        reference: { type: 'secretReference', provider: 'localPlainText', name: 'orders-sb' },
      },
    ]);
    expect(legacySecretReference('x').provider).toBe('localPlainText');
  });
});
