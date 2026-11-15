import type { EnvironmentConfig, TargetKind } from '@test-platform/contracts';
import { PlatformError } from './errors.js';
import type { TargetOf, TargetResolver } from './ports.js';

/** Resolves only targets declared in the Environment; raw URLs and connection strings are never accepted. */
export const createTargetResolver = (
  environment: Pick<EnvironmentConfig, 'id' | 'targets'>,
): TargetResolver => ({
  resolve<K extends TargetKind>(name: string, kind: K): TargetOf<K> {
    const target = Object.hasOwn(environment.targets, name) ? environment.targets[name] : undefined;
    if (!target) {
      throw new PlatformError(
        'VALIDATION_TARGET_POLICY',
        `Target "${name}" is not configured in environment "${environment.id}".`,
      );
    }
    if (target.kind !== kind) {
      throw new PlatformError(
        'VALIDATION_TARGET_POLICY',
        `Target "${name}" is a "${target.kind}" target, not "${kind}".`,
      );
    }
    return target as TargetOf<K>;
  },
});
