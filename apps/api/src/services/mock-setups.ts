import type { MockSetupAsset } from '@test-platform/contracts';
import { PlatformError } from '@test-platform/core';
import type { DefinitionService } from './definition-service.js';

/**
 * The current version of each named Mock API setup, for freezing into a Run. A missing setup is a
 * reference error, so a Run is never queued with fewer mocks than its Test or Suite asked for.
 */
export const loadMockSetups = async (
  definitions: DefinitionService,
  ids: readonly string[],
): Promise<MockSetupAsset[]> => {
  const setups: MockSetupAsset[] = [];
  for (const id of ids) {
    try {
      setups.push((await definitions.get('mock-setup', id)).asset);
    } catch (error) {
      if (error instanceof PlatformError && error.code === 'VALIDATION_NOT_FOUND')
        throw new PlatformError('VALIDATION_REFERENCE', `Mock API setup "${id}" was not found.`, {
          issues: [
            {
              path: '/helpers/mockApi/setupIds',
              message: `refers to Mock API setup "${id}", which does not exist`,
              keyword: 'reference',
            },
          ],
        });
      throw error;
    }
  }
  return setups;
};
