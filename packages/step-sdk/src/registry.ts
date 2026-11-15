import {
  createSchemaValidator,
  type JsonObject,
  type StepTypeMetadata,
  type ValidationIssue,
  type Validator,
} from '@test-platform/contracts';
import { PlatformError } from '@test-platform/core';
import type { StepDefinition } from './types.js';

const validators = new WeakMap<StepDefinition<never>, Validator<unknown>>();

/** Compiles (once) and applies the Step's configSchema. */
export const validateStepConfig = (
  definition: StepDefinition<never>,
  config: unknown,
): ValidationIssue[] => {
  let validator = validators.get(definition);
  if (!validator) {
    validator = createSchemaValidator(definition.configSchema);
    validators.set(definition, validator);
  }
  return validator(config).issues;
};

export class StepRegistry {
  readonly #definitions = new Map<string, StepDefinition<never>>();

  register<TConfig>(definition: StepDefinition<TConfig>): this {
    if (this.#definitions.has(definition.type)) {
      throw new PlatformError(
        'SYSTEM_INTERNAL',
        `Step type "${definition.type}" is already registered.`,
      );
    }
    // Fail at registration, not first use, if the schema cannot compile.
    validateStepConfig(definition as StepDefinition<never>, {});
    this.#definitions.set(definition.type, definition as StepDefinition<never>);
    return this;
  }

  has(type: string): boolean {
    return this.#definitions.has(type);
  }

  get(type: string): StepDefinition<unknown> | undefined {
    return this.#definitions.get(type) as StepDefinition<unknown> | undefined;
  }

  require(type: string): StepDefinition<unknown> {
    const definition = this.get(type);
    if (!definition)
      throw new PlatformError('VALIDATION_REFERENCE', `Unknown Step type "${type}".`);
    return definition;
  }

  /** Catalog for `GET /step-types`. */
  describe(): StepTypeMetadata[] {
    return [...this.#definitions.values()]
      .map((definition) => ({
        type: definition.type,
        displayName: definition.displayName,
        ...(definition.description ? { description: definition.description } : {}),
        configSchema: definition.configSchema,
        sensitivePaths: definition.sensitivePaths ?? [],
        defaults: (definition.defaults ?? {}) as JsonObject,
        capabilities: {
          external: definition.capabilities?.external ?? false,
          supportsRetry: definition.capabilities?.supportsRetry ?? false,
          supportsArtifacts: definition.capabilities?.supportsArtifacts ?? false,
        },
      }))
      .sort((a, b) => a.type.localeCompare(b.type));
  }
}
