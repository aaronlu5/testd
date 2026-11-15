import { describe, expect, it } from 'vitest';
import { BREAKPOINT_DEFAULTS, BREAKPOINT_STEP_TYPE } from '@test-platform/contracts';
import {
  breakpointOutput,
  breakpointStep,
  createBuiltInRegistry,
  executeStep,
  validateStepConfig,
} from '../src/index.js';
import { makeContext } from './helpers.js';

describe('breakpoint Step', () => {
  it('is registered as a dependency-free built-in with no retry or external access', () => {
    const registry = createBuiltInRegistry();
    expect(registry.has(BREAKPOINT_STEP_TYPE)).toBe(true);
    const [meta] = registry.describe().filter((m) => m.type === 'breakpoint');
    expect(meta).toMatchObject({
      displayName: 'Breakpoint',
      defaults: BREAKPOINT_DEFAULTS,
      sensitivePaths: [],
      capabilities: { external: false, supportsRetry: false, supportsArtifacts: false },
    });
  });

  it('accepts enabled with an optional message only', () => {
    const issues = (config: unknown) => validateStepConfig(breakpointStep as never, config);
    expect(issues({ enabled: true })).toEqual([]);
    expect(issues({ enabled: false, message: 'Look' })).toEqual([]);
    expect(issues({})).not.toEqual([]);
    expect(issues({ enabled: true, target: 'orders-api' })).not.toEqual([]);
    expect(issues({ enabled: true, message: 'x'.repeat(1001) })).not.toEqual([]);
  });

  it('completes immediately with a deterministic output when executed directly', async () => {
    const outcome = await executeStep(
      breakpointStep as never,
      { enabled: true, message: 'Check' },
      makeContext(),
      { timeoutMs: 1000 },
    );
    expect(outcome.result).toMatchObject({ status: 'Succeeded', output: { enabled: true } });
    expect(breakpointOutput({ enabled: false })).toEqual({ enabled: false });
    expect(breakpointOutput({ enabled: true, message: 'a' })).toEqual(
      breakpointOutput({ enabled: true, message: 'b' }),
    );
  });
});
