import type { JsonObject, JsonValue } from '@test-platform/contracts';
import {
  PlatformError,
  TARGET_LIMITS,
  assertConnectionStringMatches,
  type ServiceBusPlan,
  type TargetPolicy,
} from '@test-platform/core';
import type { StepDefinition } from '../types.js';
import {
  asTargetError,
  describeCredential,
  gateRetry,
  resolveSecret,
  utf8,
  withClient,
  type Context,
} from './support.js';

export const SERVICE_BUS_SEND_STEP_TYPE = 'serviceBus.send';

const PLATFORM_PROPERTY_PREFIX = 'platform_';
const PROPERTY_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const MESSAGE_ID = /^[\x21-\x7e]{1,128}$/;
const SUBSCRIPTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;

export type ServiceBusSendConfig = {
  target: string;
  /** Queue or topic name; must be allowed by the target. */
  entity: string;
  body: JsonValue;
  contentType?: string;
  subject?: string;
  /** Defaults to a value derived from the Run and Step, identical on every retry. */
  messageId?: string;
  correlationId?: string;
  applicationProperties?: Record<string, string | number | boolean>;
  /** The entity has duplicate detection enabled, so a repeated message ID is dropped by Service Bus. */
  duplicateDetection?: boolean;
  /** Allow a retry even without duplicate detection; the message may then be delivered twice. */
  retrySafe?: boolean;
  /**
   * Show this message in the Service Bus Inspector: a copy of what was sent is recorded, and the
   * entity is registered for peeking (when the target allows `inspect`).
   */
  inspect?: boolean;
  /** Topics only: the subscription the inspector peeks. Leave empty for a queue. */
  inspectSubscription?: string;
};

export const planServiceBusSend = (
  config: ServiceBusSendConfig,
  policy: TargetPolicy,
): ServiceBusPlan => policy.serviceBus(config.target, { entity: config.entity });

/** Retries are allowed only when a duplicate cannot (duplicate detection) or may not (opt-in) matter. */
export const serviceBusRetryAllowed = (config: ServiceBusSendConfig): boolean =>
  config.duplicateDetection === true || config.retrySafe === true;

export const defaultMessageId = (context: Context): string =>
  `${context.correlation.runId}-${context.correlation.nodeId}`.slice(0, 128);

type InspectedFields = {
  messageId: string;
  correlationId: string;
  contentType: string;
  subject?: string;
  applicationProperties: Record<string, string | number | boolean>;
  body: Uint8Array;
};

/**
 * Best-effort hand-off to the Service Bus Inspector after a successful send. It records a copy
 * of the message (so it can be inspected even if a consumer takes it instantly) and registers
 * the entity for peeking when the target allows `inspect`. It never fails the Step.
 */
const inspect = async (
  context: Context,
  config: ServiceBusSendConfig,
  entity: string,
  fields: InspectedFields,
): Promise<'registered' | 'existing' | 'not-allowed' | 'failed'> => {
  const where = {
    environmentId: context.environmentId,
    target: config.target,
    entity,
    ...(config.inspectSubscription ? { subscription: config.inspectSubscription } : {}),
  };
  let outcome: 'registered' | 'existing' | 'not-allowed';
  try {
    try {
      context.policy.serviceBus(config.target, { entity, operation: 'inspect' });
      const { created } = await context.inspector.registerWatch({
        ...where,
        createdBy: `run:${context.correlation.runId}`,
      });
      outcome = created ? 'registered' : 'existing';
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      outcome = 'not-allowed';
      context.logger.warn(
        'The entity was not registered for inspection: the target does not allow "inspect". The sent message is still recorded.',
      );
    }
    await context.inspector.recordSent({
      ...where,
      ...fields,
      runId: context.correlation.runId,
      stepRunId: context.correlation.stepRunId,
      nodeId: context.correlation.nodeId,
    });
  } catch {
    context.logger.warn('The message could not be recorded in the Service Bus Inspector.');
    return 'failed';
  }
  return outcome;
};

export const serviceBusSendStep: StepDefinition<ServiceBusSendConfig> = {
  type: SERVICE_BUS_SEND_STEP_TYPE,
  displayName: 'Service Bus send',
  description:
    'Sends one message to an allowlisted queue or topic. The message ID is deterministic, so with duplicate detection enabled on the entity a retry cannot duplicate the message. Without it, a failed send is not retried unless you opt in with "retrySafe".',
  configSchema: {
    type: 'object',
    required: ['target', 'entity', 'body'],
    additionalProperties: false,
    properties: {
      target: {
        type: 'string',
        minLength: 1,
        description: 'Logical Service Bus target from the Environment.',
      },
      entity: { type: 'string', minLength: 1, maxLength: 260, description: 'Queue or topic name.' },
      body: { description: 'String or JSON value sent as the message body.' },
      contentType: { type: 'string', minLength: 1, maxLength: 256 },
      subject: { type: 'string', maxLength: 2048 },
      messageId: { type: 'string', minLength: 1, maxLength: 128 },
      correlationId: { type: 'string', minLength: 1, maxLength: 128 },
      applicationProperties: {
        type: 'object',
        additionalProperties: { type: ['string', 'number', 'boolean'] },
      },
      duplicateDetection: { type: 'boolean' },
      retrySafe: { type: 'boolean' },
      inspect: {
        type: 'boolean',
        description:
          'Show the sent message in the Service Bus Inspector and register this queue/topic there so messages from other senders are collected too.',
      },
      inspectSubscription: {
        type: 'string',
        minLength: 1,
        maxLength: 50,
        description:
          'Topic only: the subscription the inspector should peek. Use a subscription dedicated to inspection, because a consumed message cannot be seen. Leave empty for a queue.',
      },
    },
  },
  sensitivePaths: [],
  defaults: { duplicateDetection: false, retrySafe: false, inspect: false },
  capabilities: { external: true, supportsRetry: true, supportsArtifacts: false },
  validate(config, context) {
    const issues = [];
    if (config.messageId !== undefined && !MESSAGE_ID.test(config.messageId))
      issues.push({
        path: '/messageId',
        message: 'must be 1 to 128 printable ASCII characters without spaces',
        keyword: 'step-config',
      });
    if (config.inspectSubscription !== undefined) {
      if (!SUBSCRIPTION_NAME.test(config.inspectSubscription))
        issues.push({
          path: '/inspectSubscription',
          message: 'is not a valid subscription name',
          keyword: 'step-config',
        });
      if (config.inspect !== true)
        issues.push({
          path: '/inspectSubscription',
          message: 'has no effect unless "inspect" is true',
          keyword: 'step-config',
        });
    }
    for (const key of Object.keys(config.applicationProperties ?? {})) {
      if (!PROPERTY_KEY.test(key) || key.toLowerCase().startsWith(PLATFORM_PROPERTY_PREFIX))
        issues.push({
          path: `/applicationProperties/${key}`,
          message: `is not a valid property name ("${PLATFORM_PROPERTY_PREFIX}" is reserved)`,
          keyword: 'step-config',
        });
    }
    if (context.targets) {
      try {
        context.targets.resolve(config.target, 'azureServiceBus');
      } catch (error) {
        issues.push({
          path: '/target',
          message: error instanceof PlatformError ? error.message : 'Unknown target.',
          keyword: 'target-policy',
        });
      }
    }
    return issues;
  },
  async execute(context, config) {
    const plan = planServiceBusSend(config, context.policy);
    const isText = typeof config.body === 'string';
    const body = utf8(isText ? (config.body as string) : JSON.stringify(config.body));
    const ceiling = Math.min(TARGET_LIMITS.serviceBusMessageBytes, context.limits.transferBytes);
    if (body.byteLength > ceiling)
      throw new PlatformError(
        'VALIDATION_TARGET_POLICY',
        `The message body (${body.byteLength} bytes) exceeds the limit of ${ceiling} bytes.`,
      );

    const retryAllowed = serviceBusRetryAllowed(config);
    if (!config.duplicateDetection) {
      context.logger.warn(
        retryAllowed
          ? 'Duplicate detection is not declared; a retry after an ambiguous failure may deliver the message twice.'
          : 'Duplicate detection is not declared, so a failed send will not be retried.',
      );
    }

    const { runId, stepRunId, nodeId, attempt } = context.correlation;
    const messageId = config.messageId ?? defaultMessageId(context);
    const correlationId = config.correlationId ?? runId;
    const message = {
      body,
      contentType: config.contentType ?? (isText ? 'text/plain' : 'application/json'),
      messageId,
      correlationId,
      ...(config.subject ? { subject: config.subject } : {}),
      applicationProperties: {
        ...(config.applicationProperties ?? {}),
        platform_run_id: runId,
        platform_step_run_id: stepRunId,
        platform_node_id: nodeId,
        platform_attempt: attempt,
      },
    };

    const credential = plan.target.credential;
    context.logger.info(`Authenticating to Service Bus with ${describeCredential(credential)}`);
    let client;
    if (credential) {
      const connectionString = await resolveSecret(context, credential);
      assertConnectionStringMatches(
        'azureServiceBus',
        connectionString,
        plan.fullyQualifiedNamespace,
      );
      client = context.clients.openServiceBus({
        fullyQualifiedNamespace: plan.fullyQualifiedNamespace,
        connectionString,
      });
    } else {
      client = context.clients.openServiceBus({
        fullyQualifiedNamespace: plan.fullyQualifiedNamespace,
      });
    }

    const action = `Service Bus send to ${plan.entity}`;
    await withClient(client, async (bus) => {
      try {
        await bus.send({ entity: plan.entity, message, signal: context.signal });
      } catch (error) {
        throw gateRetry(
          asTargetError(error, action),
          retryAllowed,
          'the entity is not declared to have duplicate detection ("duplicateDetection": true) and "retrySafe" is not set.',
        );
      }
    });

    context.logger.info('Message sent', { entity: plan.entity, messageId, attempt });
    const watch = config.inspect
      ? await inspect(context, config, plan.entity, {
          messageId,
          correlationId,
          contentType: message.contentType,
          ...(config.subject ? { subject: config.subject } : {}),
          applicationProperties: message.applicationProperties,
          body,
        })
      : 'not-requested';
    const output: JsonObject = {
      target: config.target,
      entity: plan.entity,
      messageId,
      correlationId,
      sizeBytes: body.byteLength,
      attempt,
      duplicateDetection: config.duplicateDetection === true,
      inspector: watch,
    };
    return { status: 'Succeeded', output, logs: context.logger.entries() };
  },
};
