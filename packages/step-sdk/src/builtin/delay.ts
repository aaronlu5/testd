import type { JsonValue } from '@test-platform/contracts';
import { cancellableSleep } from '@test-platform/core';
import type { StepDefinition } from '../types.js';

export type DelayConfig = { durationSeconds: number };

export const MAX_DELAY_SECONDS = 3600;

export const delayStep: StepDefinition<DelayConfig> = {
  type: 'delay',
  displayName: 'Delay',
  description: 'Waits for a fixed duration. Cancellation interrupts the wait.',
  configSchema: {
    type: 'object',
    required: ['durationSeconds'],
    additionalProperties: false,
    properties: { durationSeconds: { type: 'number', minimum: 0, maximum: MAX_DELAY_SECONDS } },
  },
  sensitivePaths: [],
  defaults: { durationSeconds: 1 },
  capabilities: { external: false, supportsRetry: true, supportsArtifacts: false },
  validate: () => [],
  async execute(context, config) {
    const started = context.clock.now().getTime();
    context.logger.info(`Waiting ${config.durationSeconds}s`);
    await cancellableSleep(config.durationSeconds * 1000, context.signal);
    const actualDurationMs = context.clock.now().getTime() - started;
    context.logger.info('Delay complete', { actualDurationMs });
    return {
      status: 'Succeeded',
      output: { actualDurationMs } as JsonValue,
      logs: context.logger.entries(),
    };
  },
};
