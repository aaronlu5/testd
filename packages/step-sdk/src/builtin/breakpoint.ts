import {
  BREAKPOINT_DEFAULTS,
  BREAKPOINT_STEP_TYPE,
  breakpointConfigSchema,
  type BreakpointParameters,
  type JsonObject,
} from '@test-platform/contracts';
import type { StepDefinition } from '../types.js';

/**
 * Deterministic output of a Breakpoint Step. The worker records it identically when it pauses and
 * when it resumes, so a successor that references it resolves to the same input both times.
 */
export const breakpointOutput = (config: BreakpointParameters): JsonObject => ({
  enabled: config.enabled,
});

/**
 * A Breakpoint has no behaviour of its own: the worker pauses the Run (or skips a disabled one)
 * and never calls `execute` for it. `execute` exists so the Step has a complete definition for
 * the catalog and direct use; it completes immediately.
 */
export const breakpointStep: StepDefinition<BreakpointParameters> = {
  type: BREAKPOINT_STEP_TYPE,
  displayName: 'Breakpoint',
  description:
    'Pauses the Run after the preceding Steps complete and before the next Step runs. The Run can then be inspected, resumed, or cancelled.',
  configSchema: breakpointConfigSchema,
  sensitivePaths: [],
  defaults: { ...BREAKPOINT_DEFAULTS },
  capabilities: { external: false, supportsRetry: false, supportsArtifacts: false },
  validate: () => [],
  async execute(context, config) {
    context.logger.info(config.enabled ? 'Breakpoint reached' : 'Breakpoint disabled');
    return {
      status: 'Succeeded',
      output: breakpointOutput(config),
      logs: context.logger.entries(),
    };
  },
};
