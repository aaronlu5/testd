import type { JsonObject, JsonPath, JsonSchema } from './json.js';

export type StepCapabilities = {
  /** True when the Step calls a target outside the platform. */
  external: boolean;
  supportsRetry: boolean;
  supportsArtifacts: boolean;
};

/** Catalog entry returned by `GET /step-types`. */
export type StepTypeMetadata = {
  type: string;
  displayName: string;
  description?: string;
  configSchema: JsonSchema;
  sensitivePaths: JsonPath[];
  defaults: JsonObject;
  capabilities: StepCapabilities;
};

/** Built-in, dependency-free Step that pauses a Run after the preceding Steps complete. */
export const BREAKPOINT_STEP_TYPE = 'breakpoint' as const;
export const BREAKPOINT_MESSAGE_MAX_LENGTH = 1000;

export type BreakpointParameters = {
  /** Defaults to true. A disabled Breakpoint completes immediately as `Skipped`. */
  enabled: boolean;
  /** Plain text shown to the operator while the Run is paused. */
  message?: string;
};

export const BREAKPOINT_DEFAULTS: BreakpointParameters = { enabled: true };

export const breakpointConfigSchema: JsonSchema = {
  type: 'object',
  required: ['enabled'],
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean', default: true },
    message: { type: 'string', maxLength: BREAKPOINT_MESSAGE_MAX_LENGTH },
  },
};
