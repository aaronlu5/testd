import type { JsonObject, JsonValue } from './json.js';

export const ASSET_SCHEMA_VERSION = 1 as const;
/** Phase 2 Tests add editor layout metadata; Test Data and Suites remain at schema version 1. */
export const TEST_SCHEMA_VERSION = 2 as const;
export const SUPPORTED_TEST_SCHEMA_VERSIONS = [1, 2] as const;
export type TestSchemaVersion = (typeof SUPPORTED_TEST_SCHEMA_VERSIONS)[number];

export const ASSET_TYPES = ['test', 'test-data', 'suite', 'mock-setup'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export type AssetMetadata = {
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
  updatedBy?: string;
};

/** Fields shared by every portable asset. `id` is stable; `version` is immutable once saved. */
export type AssetBase = {
  schemaVersion: typeof ASSET_SCHEMA_VERSION;
  id: string;
  version: number;
  name: string;
  description?: string;
  tags: string[];
  metadata: AssetMetadata;
};

export type RetryPolicy = {
  maxAttempts: number;
  initialDelayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
};

export type NodeExecution = {
  timeoutSeconds?: number;
  retry?: RetryPolicy;
  /** Reserved for future branching semantics; ignored in Phase 1. */
  continueOnFailure?: boolean;
};

export type NodePosition = { x: number; y: number };

export type TestNode = {
  id: string;
  type: string;
  name: string;
  parameters: JsonObject;
  execution?: NodeExecution;
  /** Canvas position; required when the Test's editor has `autoSequenceFromPosition` enabled. */
  position?: NodePosition;
};

export type TestEdgeMetadata = {
  /** True for edges the platform regenerated from node positions; they are never hand-authored. */
  systemManaged?: boolean;
};

export type TestEdge = { from: string; to: string; metadata?: TestEdgeMetadata };

export const LAYOUT_DIRECTIONS = ['vertical'] as const;
export type LayoutDirection = (typeof LAYOUT_DIRECTIONS)[number];

export type TestEditorSettings = {
  layoutDirection: LayoutDirection;
  /** When true, execution order is derived from node positions and edges are system-managed. */
  autoSequenceFromPosition: boolean;
};

/**
 * Helpers assist a Test or Suite without being part of its flow. The Mock API helper lists the
 * Mock API setups (by id) to serve while the Test or Suite runs.
 */
export type Helpers = {
  mockApi?: { setupIds: string[] };
};

export const MOCK_RULE_METHODS = [
  'GET',
  'HEAD',
  'OPTIONS',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const;
export type MockRuleMethod = (typeof MOCK_RULE_METHODS)[number];

/** One response of a Mock API setup. The first rule that matches a request answers it. */
export type MockRule = {
  /** Shown in the editor; has no effect on matching. */
  name?: string;
  /** Only requests with this method match; absent matches every method. */
  method?: MockRuleMethod;
  /**
   * A regular expression for the whole request path, such as `/orders/[0-9]+/items`. It is
   * anchored, so `/orders` does not match `/orders/1`, and the query string is not part of it.
   */
  path: string;
  status: number;
  /** JSON returned as the response body; absent means an empty body. */
  body?: JsonValue;
};

export type MockSetupAsset = AssetBase & {
  rules: MockRule[];
};

export type TestDefinition = Omit<AssetBase, 'schemaVersion'> & {
  /** 1 = Phase 1 (no editor settings); 2 = Phase 2. Version 1 Tests are upgraded on read. */
  schemaVersion: TestSchemaVersion;
  variables: Record<string, JsonValue>;
  nodes: TestNode[];
  edges: TestEdge[];
  /** Required for schema version 2; absent on legacy version 1 Tests. */
  editor?: TestEditorSettings;
  helpers?: Helpers;
};

export type TestDataAsset = AssetBase & {
  data: JsonObject;
};

export type SuiteItem = {
  testId: string;
  dataSetId: string;
  testVersion?: number;
  dataSetVersion?: number;
};

export type SuiteAsset = AssetBase & {
  items: SuiteItem[];
  /** Requested child concurrency; capped by the Environment limit. Defaults to 1. */
  maxConcurrency?: number;
  helpers?: Helpers;
};

export type AssetOf<T extends AssetType> = T extends 'test'
  ? TestDefinition
  : T extends 'test-data'
    ? TestDataAsset
    : T extends 'mock-setup'
      ? MockSetupAsset
      : SuiteAsset;
