import type { TestDefinition, TestEditorSettings } from './assets.js';
import { TEST_SCHEMA_VERSION } from './assets.js';

/** Editor settings a legacy Test receives: the stored edges stay authoritative. */
export const LEGACY_EDITOR_SETTINGS: Readonly<TestEditorSettings> = Object.freeze({
  layoutDirection: 'vertical',
  autoSequenceFromPosition: false,
});

/**
 * Pure v1 -> v2 upgrade applied when a Test is read. It adds the editor settings with position
 * sequencing disabled (an explicit opt-in follows in the editor) and changes nothing else:
 * `version`, `metadata`, nodes, edges and variables are preserved, so execution order for
 * hand-authored Tests is unchanged. Version 2 Tests are returned as-is. The stored file is not
 * rewritten until the Test is next saved, and past Run snapshots are never touched.
 */
export const upgradeTestToCurrentSchema = (test: TestDefinition): TestDefinition => {
  if (test.schemaVersion === TEST_SCHEMA_VERSION && test.editor) return test;
  return {
    ...test,
    schemaVersion: TEST_SCHEMA_VERSION,
    editor: test.editor ?? { ...LEGACY_EDITOR_SETTINGS },
  };
};
