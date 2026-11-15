import type { JsonSchema } from './json.js';
import { RUN_STATUSES, STEP_RUN_STATUSES } from './runs.js';
import {
  KEY_VAULT_SECRET_NAME_PATTERN,
  LOCAL_SECRET_NAME_PATTERN,
  SECRET_USAGES,
} from './secrets.js';
import { MOCK_RULE_METHODS } from './assets.js';
import { SUITE_RUN_ITEM_STATUSES, SUITE_RUN_STATUSES } from './suite-runs.js';

export const SCHEMA_BASE_URI = 'https://test-platform.dev/schemas';

/** UUID or ULID. */
export const ID_PATTERN =
  '^(?:[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$';
/** Flow node identifiers double as expression path segments. */
export const NODE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$';
export const ERROR_CODE_PATTERN = '^(VALIDATION|AUTH|TARGET|EXECUTION|SYSTEM)_[A-Z_]+$';

export const schemaId = (name: string): string => `${SCHEMA_BASE_URI}/${name}.json`;
const ref = (name: string, definition: string): { $ref: string } => ({
  $ref: `${schemaId(name)}#/definitions/${definition}`,
});

export const commonSchema: JsonSchema = {
  $id: schemaId('common'),
  definitions: {
    id: { type: 'string', pattern: ID_PATTERN },
    nodeId: { type: 'string', pattern: NODE_ID_PATTERN },
    timestamp: { type: 'string', format: 'date-time' },
    version: { type: 'integer', minimum: 1 },
    json: {
      anyOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'null' },
        { type: 'array' },
        { type: 'object' },
      ],
    },
    jsonObject: { type: 'object' },
    errorCode: { type: 'string', pattern: ERROR_CODE_PATTERN },
    errorInfo: {
      type: 'object',
      required: ['code', 'message'],
      additionalProperties: false,
      properties: {
        code: { type: 'string', pattern: ERROR_CODE_PATTERN },
        message: { type: 'string' },
        detail: { type: 'string' },
        correlationIds: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
    logEntry: {
      type: 'object',
      required: ['timestamp', 'level', 'message'],
      additionalProperties: false,
      properties: {
        timestamp: { type: 'string', format: 'date-time' },
        level: { enum: ['debug', 'info', 'warn', 'error'] },
        message: { type: 'string' },
        data: {},
      },
    },
    artifactReference: {
      type: 'object',
      required: ['id', 'contentType', 'sizeBytes'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: ID_PATTERN },
        contentType: { type: 'string', minLength: 1 },
        sizeBytes: { type: 'integer', minimum: 0 },
        label: { type: 'string' },
      },
    },
    secretReference: {
      oneOf: [
        {
          type: 'object',
          required: ['type', 'provider', 'name'],
          additionalProperties: false,
          properties: {
            type: { const: 'secretReference' },
            provider: { const: 'keyVault' },
            name: { type: 'string', pattern: KEY_VAULT_SECRET_NAME_PATTERN },
            usage: { enum: [...SECRET_USAGES] },
          },
        },
        {
          type: 'object',
          required: ['type', 'provider', 'name'],
          additionalProperties: false,
          properties: {
            type: { const: 'secretReference' },
            provider: { const: 'localPlainText' },
            name: { type: 'string', pattern: LOCAL_SECRET_NAME_PATTERN },
            usage: { enum: [...SECRET_USAGES] },
          },
        },
      ],
    },
    assetRef: {
      type: 'object',
      required: ['id', 'version'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: ID_PATTERN },
        version: { type: 'integer', minimum: 1 },
      },
    },
  },
};

const assetBaseProperties = {
  schemaVersion: { const: 1 },
  id: ref('common', 'id'),
  version: ref('common', 'version'),
  name: { type: 'string', minLength: 1, maxLength: 200 },
  description: { type: 'string', maxLength: 2000 },
  tags: {
    type: 'array',
    items: { type: 'string', minLength: 1, maxLength: 64 },
    uniqueItems: true,
  },
  metadata: {
    type: 'object',
    required: ['createdAt', 'createdBy'],
    additionalProperties: false,
    properties: {
      createdAt: ref('common', 'timestamp'),
      createdBy: { type: 'string', minLength: 1 },
      updatedAt: ref('common', 'timestamp'),
      updatedBy: { type: 'string', minLength: 1 },
    },
  },
};
const helpersSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mockApi: {
      type: 'object',
      required: ['setupIds'],
      additionalProperties: false,
      properties: {
        setupIds: {
          type: 'array',
          maxItems: 50,
          uniqueItems: true,
          items: ref('common', 'id'),
        },
      },
    },
  },
};
const assetBaseRequired = ['schemaVersion', 'id', 'version', 'name', 'tags', 'metadata'];

export const testSchema: JsonSchema = {
  $id: schemaId('test'),
  type: 'object',
  required: [...assetBaseRequired, 'variables', 'nodes', 'edges'],
  additionalProperties: false,
  // Schema version 2 (Phase 2) must declare its editor settings; version 1 Tests have none.
  if: { properties: { schemaVersion: { const: 2 } }, required: ['schemaVersion'] },
  then: { required: ['editor'], properties: { editor: {} } },
  properties: {
    ...assetBaseProperties,
    schemaVersion: { enum: [1, 2] },
    editor: {
      type: 'object',
      required: ['layoutDirection', 'autoSequenceFromPosition'],
      additionalProperties: false,
      properties: {
        layoutDirection: { enum: ['vertical'] },
        autoSequenceFromPosition: { type: 'boolean' },
      },
    },
    variables: { type: 'object' },
    helpers: helpersSchema,
    nodes: {
      type: 'array',
      minItems: 1,
      maxItems: 200,
      items: {
        type: 'object',
        required: ['id', 'type', 'name', 'parameters'],
        additionalProperties: false,
        properties: {
          id: ref('common', 'nodeId'),
          type: { type: 'string', pattern: '^[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*)*$' },
          name: { type: 'string', minLength: 1, maxLength: 200 },
          parameters: { type: 'object' },
          position: {
            type: 'object',
            required: ['x', 'y'],
            additionalProperties: false,
            properties: {
              x: { type: 'number', minimum: -1000000, maximum: 1000000 },
              y: { type: 'number', minimum: -1000000, maximum: 1000000 },
            },
          },
          execution: {
            type: 'object',
            additionalProperties: false,
            properties: {
              timeoutSeconds: { type: 'integer', minimum: 1 },
              continueOnFailure: { type: 'boolean' },
              retry: {
                type: 'object',
                required: ['maxAttempts'],
                additionalProperties: false,
                properties: {
                  maxAttempts: { type: 'integer', minimum: 1, maximum: 20 },
                  initialDelayMs: { type: 'integer', minimum: 0 },
                  backoffMultiplier: { type: 'number', minimum: 1 },
                  maxDelayMs: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['from', 'to'],
        additionalProperties: false,
        properties: {
          from: ref('common', 'nodeId'),
          to: ref('common', 'nodeId'),
          metadata: {
            type: 'object',
            additionalProperties: false,
            properties: { systemManaged: { type: 'boolean' } },
          },
        },
      },
    },
  },
};

export const testDataSchema: JsonSchema = {
  $id: schemaId('test-data'),
  type: 'object',
  required: [...assetBaseRequired, 'data'],
  additionalProperties: false,
  properties: { ...assetBaseProperties, data: { type: 'object' } },
};

export const MOCK_RULE_PATH_MAX_LENGTH = 300;

export const mockSetupSchema: JsonSchema = {
  $id: schemaId('mock-setup'),
  type: 'object',
  required: [...assetBaseRequired, 'rules'],
  additionalProperties: false,
  properties: {
    ...assetBaseProperties,
    rules: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        required: ['path', 'status'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', maxLength: 200 },
          method: { enum: [...MOCK_RULE_METHODS] },
          path: {
            type: 'string',
            minLength: 1,
            maxLength: MOCK_RULE_PATH_MAX_LENGTH,
            pattern: '^/',
          },
          status: { type: 'integer', minimum: 100, maximum: 599 },
          body: {},
        },
      },
    },
  },
};

export const suiteSchema: JsonSchema = {
  $id: schemaId('suite'),
  type: 'object',
  required: [...assetBaseRequired, 'items'],
  additionalProperties: false,
  properties: {
    ...assetBaseProperties,
    maxConcurrency: { type: 'integer', minimum: 1, maximum: 64 },
    helpers: helpersSchema,
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['testId', 'dataSetId'],
        additionalProperties: false,
        properties: {
          testId: ref('common', 'id'),
          dataSetId: ref('common', 'id'),
          testVersion: ref('common', 'version'),
          dataSetVersion: ref('common', 'version'),
        },
      },
    },
  },
};

const environmentDefinition: JsonSchema = {
  type: 'object',
  required: ['id', 'name', 'classification', 'targets'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' },
    name: { type: 'string', minLength: 1 },
    classification: { enum: ['LOCAL', 'TEST', 'STAGING', 'PRODUCTION'] },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxStepTimeoutSeconds: { type: 'integer', minimum: 1 },
        maxRetryAttempts: { type: 'integer', minimum: 1 },
        maxPayloadCaptureBytes: { type: 'integer', minimum: 1 },
        maxArtifactBytes: { type: 'integer', minimum: 1 },
        maxSuiteSize: { type: 'integer', minimum: 1 },
        maxSuiteConcurrency: { type: 'integer', minimum: 1, maximum: 64 },
      },
    },
    values: {
      type: 'object',
      additionalProperties: { type: ['string', 'number', 'boolean'] },
    },
    targets: {
      type: 'object',
      propertyNames: { pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' },
      additionalProperties: {
        type: 'object',
        discriminator: { propertyName: 'kind' },
        oneOf: [
          {
            type: 'object',
            required: ['kind', 'baseUrl', 'allowedPaths'],
            additionalProperties: false,
            properties: {
              kind: { const: 'http' },
              baseUrl: { type: 'string', format: 'uri', pattern: '^https?://' },
              allowedPaths: { type: 'array', items: { type: 'string', pattern: '^/' } },
              allowedMethods: { type: 'array', items: { type: 'string' } },
              secretRef: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]*$' },
              authentication: ref('common', 'secretReference'),
              correlationHeaders: { type: 'boolean' },
            },
          },
          {
            type: 'object',
            required: ['kind', 'accountUrl', 'allowedContainers'],
            additionalProperties: false,
            properties: {
              kind: { const: 'azureBlob' },
              accountUrl: { type: 'string', format: 'uri', pattern: '^https?://' },
              allowedContainers: { type: 'array', items: { type: 'string', minLength: 1 } },
              allowedOperations: {
                type: 'array',
                items: { enum: ['upload', 'download'] },
                uniqueItems: true,
              },
              allowedBlobPrefixes: { type: 'array', items: { type: 'string', minLength: 1 } },
              credential: ref('common', 'secretReference'),
            },
          },
          {
            type: 'object',
            required: ['kind', 'allowedEntities'],
            anyOf: [
              { required: ['namespace'], properties: { namespace: {} } },
              {
                required: ['fullyQualifiedNamespace'],
                properties: { fullyQualifiedNamespace: {} },
              },
            ],
            additionalProperties: false,
            properties: {
              kind: { const: 'azureServiceBus' },
              namespace: { type: 'string', minLength: 1 },
              fullyQualifiedNamespace: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9.-]*$' },
              allowedEntities: { type: 'array', items: { type: 'string', minLength: 1 } },
              allowedOperations: {
                type: 'array',
                items: { enum: ['send', 'inspect'] },
                uniqueItems: true,
              },
              credential: ref('common', 'secretReference'),
            },
          },
          {
            type: 'object',
            required: ['kind', 'server', 'database'],
            additionalProperties: false,
            properties: {
              kind: { const: 'sqlServer' },
              server: {
                type: 'string',
                pattern: '^[A-Za-z0-9][A-Za-z0-9.\\-\\\\]*(,[0-9]{1,5})?$',
              },
              database: { type: 'string', minLength: 1 },
              allowedSchemas: { type: 'array', items: { type: 'string', minLength: 1 } },
              allowedOperations: {
                type: 'array',
                items: { enum: ['query', 'insert', 'update', 'delete'] },
                uniqueItems: true,
              },
              credential: ref('common', 'secretReference'),
            },
          },
        ],
      },
    },
  },
};

export const environmentSchema: JsonSchema = {
  $id: schemaId('environment'),
  ...environmentDefinition,
};

export const environmentsFileSchema: JsonSchema = {
  $id: schemaId('environments-file'),
  type: 'object',
  required: ['environments'],
  additionalProperties: false,
  properties: {
    environments: { type: 'array', items: { $ref: schemaId('environment') } },
  },
};

export const runSchema: JsonSchema = {
  $id: schemaId('run'),
  type: 'object',
  required: [
    'id',
    'kind',
    'status',
    'environmentId',
    'requestedBy',
    'requestedAt',
    'variableOverrides',
    'snapshots',
  ],
  additionalProperties: false,
  properties: {
    id: ref('common', 'id'),
    kind: { enum: ['test', 'suite'] },
    status: { enum: [...RUN_STATUSES] },
    environmentId: { type: 'string' },
    requestedBy: { type: 'string', minLength: 1 },
    requestedAt: ref('common', 'timestamp'),
    startedAt: ref('common', 'timestamp'),
    finishedAt: ref('common', 'timestamp'),
    cancelRequestedAt: ref('common', 'timestamp'),
    pausedAt: ref('common', 'timestamp'),
    continuationGeneration: { type: 'integer', minimum: 0 },
    parentRunId: ref('common', 'id'),
    rerunOfRunId: ref('common', 'id'),
    test: ref('common', 'assetRef'),
    testData: ref('common', 'assetRef'),
    suite: ref('common', 'assetRef'),
    variableOverrides: { type: 'object' },
    snapshots: {
      type: 'object',
      required: ['environment'],
      additionalProperties: false,
      properties: {
        test: { $ref: schemaId('test') },
        testData: { $ref: schemaId('test-data') },
        suite: { $ref: schemaId('suite') },
        environment: { $ref: schemaId('environment') },
        mockSetups: { type: 'array', items: { $ref: schemaId('mock-setup') } },
      },
    },
    error: ref('common', 'errorInfo'),
  },
};

export const stepRunSchema: JsonSchema = {
  $id: schemaId('step-run'),
  type: 'object',
  required: ['id', 'runId', 'nodeId', 'attempt', 'status', 'logs', 'artifacts'],
  additionalProperties: false,
  properties: {
    id: ref('common', 'id'),
    runId: ref('common', 'id'),
    nodeId: ref('common', 'nodeId'),
    attempt: { type: 'integer', minimum: 1 },
    status: { enum: [...STEP_RUN_STATUSES] },
    resolvedInput: {},
    outputPreview: {},
    error: ref('common', 'errorInfo'),
    logs: { type: 'array', items: ref('common', 'logEntry') },
    artifacts: { type: 'array', items: ref('common', 'artifactReference') },
    startedAt: ref('common', 'timestamp'),
    finishedAt: ref('common', 'timestamp'),
    durationMs: { type: 'integer', minimum: 0 },
  },
};

export const artifactSchema: JsonSchema = {
  $id: schemaId('artifact'),
  type: 'object',
  required: ['id', 'runId', 'stepRunId', 'contentType', 'sizeBytes', 'sha256', 'createdAt'],
  additionalProperties: false,
  properties: {
    id: ref('common', 'id'),
    runId: ref('common', 'id'),
    stepRunId: ref('common', 'id'),
    contentType: { type: 'string', minLength: 1 },
    sizeBytes: { type: 'integer', minimum: 0 },
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    createdAt: ref('common', 'timestamp'),
  },
};

export const problemDetailsSchema: JsonSchema = {
  $id: schemaId('problem-details'),
  type: 'object',
  required: ['type', 'title', 'status', 'code'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    status: { type: 'integer', minimum: 100, maximum: 599 },
    detail: { type: 'string' },
    instance: { type: 'string' },
    code: ref('common', 'errorCode'),
    requestId: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'message'],
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          message: { type: 'string' },
          keyword: { type: 'string' },
        },
      },
    },
  },
};

export const stepTypeMetadataSchema: JsonSchema = {
  $id: schemaId('step-type-metadata'),
  type: 'object',
  required: ['type', 'displayName', 'configSchema', 'sensitivePaths', 'defaults', 'capabilities'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', minLength: 1 },
    displayName: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    configSchema: { type: 'object' },
    sensitivePaths: { type: 'array', items: { type: 'string' } },
    defaults: { type: 'object' },
    capabilities: {
      type: 'object',
      required: ['external', 'supportsRetry', 'supportsArtifacts'],
      additionalProperties: false,
      properties: {
        external: { type: 'boolean' },
        supportsRetry: { type: 'boolean' },
        supportsArtifacts: { type: 'boolean' },
      },
    },
  },
};

const eventEnvelope = (type: string, data: JsonSchema): JsonSchema => ({
  type: 'object',
  required: ['type', 'runId', 'timestamp', 'data'],
  additionalProperties: false,
  properties: {
    seq: { type: 'integer', minimum: 1 },
    type: { const: type },
    runId: ref('common', 'id'),
    timestamp: ref('common', 'timestamp'),
    data,
  },
});

export const runEventSchema: JsonSchema = {
  $id: schemaId('run-event'),
  oneOf: [
    eventEnvelope('run.status', {
      type: 'object',
      required: ['status'],
      additionalProperties: false,
      properties: { status: { enum: [...RUN_STATUSES] } },
    }),
    eventEnvelope('step.status', {
      type: 'object',
      required: ['stepRunId', 'nodeId', 'attempt', 'status'],
      additionalProperties: false,
      properties: {
        stepRunId: ref('common', 'id'),
        nodeId: ref('common', 'nodeId'),
        attempt: { type: 'integer', minimum: 1 },
        status: { enum: [...STEP_RUN_STATUSES] },
      },
    }),
    eventEnvelope('step.log', {
      type: 'object',
      required: ['stepRunId', 'entry'],
      additionalProperties: false,
      properties: { stepRunId: ref('common', 'id'), entry: ref('common', 'logEntry') },
    }),
    eventEnvelope('artifact.created', {
      type: 'object',
      required: ['stepRunId', 'artifact'],
      additionalProperties: false,
      properties: {
        stepRunId: ref('common', 'id'),
        artifact: ref('common', 'artifactReference'),
      },
    }),
    eventEnvelope('run.paused', {
      type: 'object',
      required: [
        'pauseId',
        'breakpointStepRunId',
        'breakpointNodeId',
        'nextNodeId',
        'continuationGeneration',
        'pausedAt',
      ],
      additionalProperties: false,
      properties: {
        pauseId: ref('common', 'id'),
        breakpointStepRunId: ref('common', 'id'),
        breakpointNodeId: ref('common', 'nodeId'),
        nextNodeId: { anyOf: [ref('common', 'nodeId'), { type: 'null' }] },
        continuationGeneration: { type: 'integer', minimum: 0 },
        pausedAt: ref('common', 'timestamp'),
      },
    }),
    eventEnvelope('run.resumed', {
      type: 'object',
      required: ['pauseId', 'continuationGeneration', 'resumedAt'],
      additionalProperties: false,
      properties: {
        pauseId: ref('common', 'id'),
        continuationGeneration: { type: 'integer', minimum: 1 },
        resumedAt: ref('common', 'timestamp'),
      },
    }),
    eventEnvelope('run.cancelled', {
      type: 'object',
      required: ['cancelledAt', 'whilePaused'],
      additionalProperties: false,
      properties: { cancelledAt: ref('common', 'timestamp'), whilePaused: { type: 'boolean' } },
    }),
    eventEnvelope('run.step.updated', {
      type: 'object',
      required: ['stepRunId', 'nodeId', 'attempt', 'status'],
      additionalProperties: false,
      properties: {
        stepRunId: ref('common', 'id'),
        nodeId: ref('common', 'nodeId'),
        attempt: { type: 'integer', minimum: 1 },
        status: { enum: [...STEP_RUN_STATUSES] },
      },
    }),
  ],
};

export const runPauseSchema: JsonSchema = {
  $id: schemaId('run-pause'),
  type: 'object',
  required: [
    'id',
    'runId',
    'breakpointStepRunId',
    'breakpointNodeId',
    'nextNodeId',
    'pausedAt',
    'continuationGeneration',
  ],
  additionalProperties: false,
  properties: {
    id: ref('common', 'id'),
    runId: ref('common', 'id'),
    breakpointStepRunId: ref('common', 'id'),
    breakpointNodeId: ref('common', 'nodeId'),
    message: { type: 'string', maxLength: 1000 },
    nextNodeId: { anyOf: [ref('common', 'nodeId'), { type: 'null' }] },
    nextNodeName: { type: 'string' },
    nextNodeType: { type: 'string' },
    nextResolvedInputPreview: {},
    nextInputArtifactId: ref('common', 'id'),
    pausedAt: ref('common', 'timestamp'),
    continuationGeneration: { type: 'integer', minimum: 0 },
    resumedAt: ref('common', 'timestamp'),
    cancelledAt: ref('common', 'timestamp'),
  },
};

export const suiteRunItemSchema: JsonSchema = {
  $id: schemaId('suite-run-item'),
  type: 'object',
  required: ['id', 'suiteRunId', 'position', 'test', 'testData', 'status'],
  additionalProperties: false,
  properties: {
    id: ref('common', 'id'),
    suiteRunId: ref('common', 'id'),
    position: { type: 'integer', minimum: 0 },
    test: ref('common', 'assetRef'),
    testData: ref('common', 'assetRef'),
    runId: ref('common', 'id'),
    status: { enum: [...SUITE_RUN_ITEM_STATUSES] },
    dispatchedAt: ref('common', 'timestamp'),
    finishedAt: ref('common', 'timestamp'),
  },
};

export const suiteRunSchema: JsonSchema = {
  $id: schemaId('suite-run'),
  type: 'object',
  required: [
    'id',
    'status',
    'environmentId',
    'suite',
    'requestedBy',
    'requestedAt',
    'maxConcurrency',
    'variableOverrides',
    'snapshots',
  ],
  additionalProperties: false,
  properties: {
    id: ref('common', 'id'),
    status: { enum: [...SUITE_RUN_STATUSES] },
    environmentId: { type: 'string' },
    suite: ref('common', 'assetRef'),
    requestedBy: { type: 'string', minLength: 1 },
    requestedAt: ref('common', 'timestamp'),
    startedAt: ref('common', 'timestamp'),
    finishedAt: ref('common', 'timestamp'),
    cancelRequestedAt: ref('common', 'timestamp'),
    rerunOfSuiteRunId: ref('common', 'id'),
    maxConcurrency: { type: 'integer', minimum: 1, maximum: 64 },
    variableOverrides: { type: 'object' },
    snapshots: {
      type: 'object',
      required: ['suite', 'tests', 'testData', 'environment'],
      additionalProperties: false,
      properties: {
        suite: { $ref: schemaId('suite') },
        tests: { type: 'array', items: { $ref: schemaId('test') } },
        testData: { type: 'array', items: { $ref: schemaId('test-data') } },
        environment: { $ref: schemaId('environment') },
        mockSetups: { type: 'array', items: { $ref: schemaId('mock-setup') } },
      },
    },
    error: ref('common', 'errorInfo'),
  },
};

const suiteRunCountKeys = ['total', ...SUITE_RUN_ITEM_STATUSES];

export const suiteRunEventSchema: JsonSchema = {
  $id: schemaId('suite-run-event'),
  type: 'object',
  required: ['type', 'suiteRunId', 'timestamp', 'data'],
  additionalProperties: false,
  properties: {
    seq: { type: 'integer', minimum: 1 },
    type: { const: 'suiteRun.updated' },
    suiteRunId: ref('common', 'id'),
    timestamp: ref('common', 'timestamp'),
    data: {
      type: 'object',
      required: ['status', 'counts'],
      additionalProperties: false,
      properties: {
        status: { enum: [...SUITE_RUN_STATUSES] },
        counts: {
          type: 'object',
          required: suiteRunCountKeys,
          additionalProperties: false,
          properties: Object.fromEntries(
            suiteRunCountKeys.map((key) => [key, { type: 'integer', minimum: 0 }]),
          ),
        },
      },
    },
  },
};

export const allSchemas: JsonSchema[] = [
  commonSchema,
  testSchema,
  testDataSchema,
  suiteSchema,
  mockSetupSchema,
  environmentSchema,
  environmentsFileSchema,
  runSchema,
  stepRunSchema,
  artifactSchema,
  problemDetailsSchema,
  stepTypeMetadataSchema,
  runEventSchema,
  runPauseSchema,
  suiteRunItemSchema,
  suiteRunSchema,
  suiteRunEventSchema,
];
