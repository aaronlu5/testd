import type {
  AzureBlobOperation,
  AzureBlobTarget,
  AzureServiceBusOperation,
  AzureServiceBusTarget,
  EnvironmentConfig,
  EnvironmentTarget,
  HttpTarget,
  SecretReference,
  SqlServerTarget,
  ValidationIssue,
} from '@test-platform/contracts';
import { PlatformError } from './errors.js';
import { isSensitiveKey } from './redaction.js';
import { createTargetResolver } from './target.js';
import { legacySecretReference } from './secrets.js';
import { analyzeSqlStatement, type SqlOperation } from './sql-statement.js';

/**
 * Target policy: the single place that decides whether a Step may touch a configured target.
 * Tests name logical targets only; every host, container, entity, path, operation and size
 * decision is made here from the Environment, never from Test parameters.
 */

export const HTTP_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
/** Used when a target does not list `allowedMethods`. DELETE must always be named explicitly. */
export const DEFAULT_HTTP_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH'];
export const SAFE_HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export const DEFAULT_BLOB_OPERATIONS: readonly AzureBlobOperation[] = ['upload', 'download'];

/** Hard ceilings that apply even when an Environment sets no limit of its own. */
export const TARGET_LIMITS = {
  httpRequestBytes: 1024 * 1024,
  httpResponseBytes: 10 * 1024 * 1024,
  blobBytes: 10 * 1024 * 1024,
  serviceBusMessageBytes: 256 * 1024,
  sqlMaxRows: 1000,
  sqlTimeoutSeconds: 120,
} as const;

export const DEFAULT_SQL_OPERATIONS: readonly SqlOperation[] = ['query'];
const SQL_SERVER_HOST = /^[A-Za-z0-9][A-Za-z0-9.\\-]*(,[0-9]{1,5})?$/;

const CONTAINER_NAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$|^\$root$/;
const SERVICE_BUS_ENTITY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,259}$/;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const policyError = (message: string): PlatformError =>
  new PlatformError('VALIDATION_TARGET_POLICY', message);

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '127.0.0.1' ||
  hostname === '[::1]' ||
  hostname.endsWith('.localhost');

// --- Glob matching ----------------------------------------------------------------------------

const escapeRegExp = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** `*` matches within one path segment; `**` matches across segments. Everything else is literal. */
export const matchesGlob = (pattern: string, value: string): boolean => {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);
    if (char === '*') {
      if (pattern.charAt(i + 1) === '*') {
        source += '.*';
        i += 1;
      } else source += '[^/]*';
    } else source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`).test(value);
};

// --- Names and paths --------------------------------------------------------------------------

/**
 * A request path is relative to the target's base URL: it starts with exactly one `/`, carries no
 * scheme, authority, query, fragment, backslash, control character or dot segment (including
 * percent-encoded ones), so it cannot leave the base host or the allowed path prefix.
 */
export const assertRelativePath = (path: string): void => {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw policyError('The path must be relative to the target and start with a single "/".');
  if (/[?#\\]/.test(path) || CONTROL_CHARS.test(path))
    throw policyError(
      'The path must not contain a query, fragment, backslash or control character.',
    );
  if (/%(?:2e|2f|5c|00)/i.test(path))
    throw policyError('The path must not contain encoded dots, slashes or null bytes.');
  if (path.split('/').some((segment) => segment === '.' || segment === '..'))
    throw policyError('The path must not contain "." or ".." segments.');
};

export const assertBlobName = (name: string): void => {
  if (name.length === 0 || Buffer.byteLength(name) > 1024)
    throw policyError('The blob name must be 1 to 1024 bytes.');
  if (CONTROL_CHARS.test(name) || name.includes('\\'))
    throw policyError('The blob name must not contain control characters or backslashes.');
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//'))
    throw policyError('The blob name must not start or end with "/" or contain "//".');
  if (name.split('/').some((segment) => segment === '.' || segment === '..'))
    throw policyError('The blob name must not contain "." or ".." segments.');
};

export const isValidContainerName = (name: string): boolean => CONTAINER_NAME.test(name);
export const isValidServiceBusEntity = (name: string): boolean => SERVICE_BUS_ENTITY.test(name);

/** Header names a Test may not set: credentials come from the target, framing from the transport. */
const RESERVED_HEADERS = new Set([
  'host',
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'ocp-apim-subscription-key',
  'ocp-apim-trace',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'keep-alive',
  'x-correlation-id',
]);

export const assertRequestHeaders = (headers: Record<string, string>): void => {
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) throw policyError(`Header name "${name}" is not valid.`);
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.has(lower) || lower.startsWith('x-test-platform-'))
      throw policyError(`Header "${name}" is managed by the platform and cannot be set by a Test.`);
    if (isSensitiveKey(name))
      throw policyError(
        `Header "${name}" looks like a credential; credentials come from the target's secret reference.`,
      );
    if (CONTROL_CHARS.test(value)) throw policyError(`Header "${name}" has an invalid value.`);
  }
};

// --- Target configuration validation (Environment load time) ----------------------------------

const cfg = (path: string, message: string): ValidationIssue => ({
  path,
  message,
  keyword: 'target-config',
});

const checkUrl = (
  path: string,
  value: string,
  options: { allowPath: boolean },
): ValidationIssue[] => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [cfg(path, 'Must be an absolute URL.')];
  }
  const issues: ValidationIssue[] = [];
  const loopback = isLoopback(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    issues.push(cfg(path, 'Must use https (http is allowed only for localhost).'));
  if (url.username || url.password)
    issues.push(cfg(path, 'Must not embed credentials; use a secret reference.'));
  if (url.search || url.hash)
    issues.push(
      cfg(
        path,
        'Must not contain a query or fragment (for example a SAS token); use a secret reference.',
      ),
    );
  if (!options.allowPath && url.pathname !== '/' && !loopback)
    issues.push(cfg(path, 'Must not contain a path.'));
  return issues;
};

const checkSecretUsage = (
  path: string,
  reference: SecretReference | undefined,
  allowed: readonly string[],
): ValidationIssue[] =>
  reference?.usage !== undefined && !allowed.includes(reference.usage)
    ? [cfg(`${path}/usage`, `Must be ${allowed.map((item) => `"${item}"`).join(' or ')}.`)]
    : [];

const checkNames = (
  path: string,
  values: readonly string[],
  valid: (value: string) => boolean,
  what: string,
): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  if (values.length === 0) issues.push(cfg(path, `At least one ${what} must be allowed.`));
  values.forEach((value, index) => {
    if (!valid(value)) issues.push(cfg(`${path}/${index}`, `"${value}" is not a valid ${what}.`));
  });
  return issues;
};

export const serviceBusNamespaceHost = (target: AzureServiceBusTarget): string | undefined => {
  const raw = (target.fullyQualifiedNamespace ?? target.namespace)?.trim().toLowerCase();
  if (!raw) return undefined;
  // `localhost` is the local emulator, not a short Azure namespace name.
  return raw.includes('.') || raw === 'localhost' ? raw : `${raw}.servicebus.windows.net`;
};

/** Semantic checks on top of the Environment JSON Schema; run when configuration is loaded. */
export const validateTargetConfiguration = (
  name: string,
  target: EnvironmentTarget,
): ValidationIssue[] => {
  const base = `/targets/${name}`;
  switch (target.kind) {
    case 'http': {
      const issues = checkUrl(`${base}/baseUrl`, target.baseUrl, { allowPath: true });
      target.allowedPaths.forEach((pattern, index) => {
        try {
          assertRelativePath(pattern.replaceAll('*', 'x'));
        } catch {
          issues.push(cfg(`${base}/allowedPaths/${index}`, 'Must be a relative path pattern.'));
        }
      });
      if (target.allowedPaths.length === 0)
        issues.push(cfg(`${base}/allowedPaths`, 'At least one path must be allowed.'));
      target.allowedMethods?.forEach((method, index) => {
        if (!(HTTP_METHODS as readonly string[]).includes(method))
          issues.push(
            cfg(`${base}/allowedMethods/${index}`, `"${method}" is not a supported method.`),
          );
      });
      issues.push(
        ...checkSecretUsage(`${base}/authentication`, target.authentication, [
          'apiKey',
          'bearerToken',
        ]),
      );
      return issues;
    }
    case 'azureBlob': {
      const issues = checkUrl(`${base}/accountUrl`, target.accountUrl, { allowPath: true });
      issues.push(
        ...checkNames(
          `${base}/allowedContainers`,
          target.allowedContainers,
          isValidContainerName,
          'container name',
        ),
      );
      target.allowedBlobPrefixes?.forEach((prefix, index) => {
        try {
          assertBlobName(prefix.endsWith('/') ? prefix.slice(0, -1) || 'x' : prefix);
        } catch {
          issues.push(cfg(`${base}/allowedBlobPrefixes/${index}`, 'Is not a valid blob prefix.'));
        }
      });
      issues.push(
        ...checkSecretUsage(`${base}/credential`, target.credential, ['connectionString']),
      );
      return issues;
    }
    case 'azureServiceBus': {
      const issues: ValidationIssue[] = [];
      const host = serviceBusNamespaceHost(target);
      if (!host || !HOSTNAME.test(host))
        issues.push(cfg(`${base}/fullyQualifiedNamespace`, 'Must be a valid namespace host name.'));
      issues.push(
        ...checkNames(
          `${base}/allowedEntities`,
          target.allowedEntities,
          isValidServiceBusEntity,
          'queue or topic name',
        ),
      );
      issues.push(
        ...checkSecretUsage(`${base}/credential`, target.credential, ['connectionString']),
      );
      return issues;
    }
    case 'sqlServer': {
      const issues: ValidationIssue[] = [];
      if (!SQL_SERVER_HOST.test(target.server))
        issues.push(cfg(`${base}/server`, 'Must be a host name, optionally followed by ",port".'));
      if (target.database.trim() === '') issues.push(cfg(`${base}/database`, 'Must not be empty.'));
      issues.push(
        ...checkSecretUsage(`${base}/credential`, target.credential, ['connectionString']),
      );
      return issues;
    }
  }
};

/** Classifications whose secrets must live in Key Vault; plain text is for local and test use only. */
export const KEY_VAULT_ONLY_CLASSIFICATIONS: readonly string[] = ['STAGING', 'PRODUCTION'];

/**
 * Plain-text secrets are acceptable on a local machine and for test resources, but an Environment
 * classified STAGING or PRODUCTION must reference Key Vault secrets only.
 */
export const validateSecretProviderPolicy = (
  environment: Pick<EnvironmentConfig, 'targets'> & { classification?: string },
): ValidationIssue[] => {
  if (
    !environment.classification ||
    !KEY_VAULT_ONLY_CLASSIFICATIONS.includes(environment.classification)
  )
    return [];
  const issues: ValidationIssue[] = [];
  const message = `A ${environment.classification} Environment must reference Key Vault secrets; plain-text secrets are only for LOCAL and TEST Environments.`;
  for (const [name, target] of Object.entries(environment.targets)) {
    const base = `/targets/${name}`;
    if (target.kind === 'http') {
      if (target.authentication?.provider === 'localPlainText')
        issues.push(cfg(`${base}/authentication/provider`, message));
      if (target.secretRef) issues.push(cfg(`${base}/secretRef`, message));
    } else if (target.credential?.provider === 'localPlainText') {
      issues.push(cfg(`${base}/credential/provider`, message));
    }
  }
  return issues;
};

export const validateEnvironmentTargets = (
  environment: Pick<EnvironmentConfig, 'targets'> & { classification?: string },
): ValidationIssue[] => [
  ...Object.entries(environment.targets).flatMap(([name, target]) =>
    validateTargetConfiguration(name, target),
  ),
  ...validateSecretProviderPolicy(environment),
];

// --- Policy resolver --------------------------------------------------------------------------

export type HttpRequestPlan = {
  target: HttpTarget;
  method: HttpMethod;
  /** Absolute URL on the target's host. Never log it with a query: use `path`. */
  url: string;
  path: string;
  authentication?: SecretReference;
  correlationHeaders: boolean;
};

export type BlobPlan = {
  target: AzureBlobTarget;
  operation: AzureBlobOperation;
  container: string;
  blobName: string;
  accountHost: string;
};

export type ServiceBusPlan = {
  target: AzureServiceBusTarget;
  entity: string;
  fullyQualifiedNamespace: string;
};

export type SqlPlan = {
  target: SqlServerTarget;
  operation: SqlOperation;
  /** Host name without a port. */
  host: string;
  port?: number;
  database: string;
  /** Parameter names (without `@`) the statement references. */
  parameters: string[];
};

export const sqlServerHost = (target: SqlServerTarget): { host: string; port?: number } => {
  const [host = '', port] = target.server.split(',');
  return { host: host.toLowerCase(), ...(port ? { port: Number(port) } : {}) };
};

export interface TargetPolicy {
  http(
    name: string,
    request: { method: string; path: string; query?: Record<string, string | number | boolean> },
  ): HttpRequestPlan;
  blob(
    name: string,
    request: { operation: AzureBlobOperation; container: string; blobName: string },
  ): BlobPlan;
  serviceBus(
    name: string,
    request: { entity: string; operation?: AzureServiceBusOperation },
  ): ServiceBusPlan;
  /**
   * Checks one SQL statement against the target: the operation it performs must be allowed and
   * every table it touches must be in an allowed schema. `kind` is what the Step claims to be.
   */
  sql(name: string, request: { statement: string; kind: 'query' | 'write' }): SqlPlan;
}

export const createTargetPolicy = (
  environment: Pick<EnvironmentConfig, 'id' | 'targets'>,
): TargetPolicy => {
  const targets = createTargetResolver(environment);

  return {
    http(name, request) {
      const target = targets.resolve(name, 'http');
      const method = request.method.toUpperCase();
      const allowed = (target.allowedMethods ?? DEFAULT_HTTP_METHODS).map((item) =>
        item.toUpperCase(),
      );
      if (!(HTTP_METHODS as readonly string[]).includes(method) || !allowed.includes(method))
        throw policyError(`Method ${method} is not allowed for target "${name}".`);
      assertRelativePath(request.path);
      if (!target.allowedPaths.some((pattern) => matchesGlob(pattern, request.path)))
        throw policyError(`Path "${request.path}" is not allowed for target "${name}".`);

      const base = new URL(target.baseUrl);
      const basePath = base.pathname.replace(/\/+$/, '');
      const url = new URL(`${basePath}${request.path}`, base);
      for (const [key, value] of Object.entries(request.query ?? {}))
        url.searchParams.append(key, String(value));
      // Defence in depth: whatever the path contained, the request must stay on the base origin.
      if (url.origin !== base.origin || !url.pathname.startsWith(`${basePath}/`))
        throw policyError('The request would leave the target base URL.');

      const authentication =
        target.authentication ??
        (target.secretRef ? legacySecretReference(target.secretRef) : undefined);
      return {
        target,
        method: method as HttpMethod,
        url: url.toString(),
        path: request.path,
        ...(authentication ? { authentication } : {}),
        correlationHeaders: target.correlationHeaders !== false,
      };
    },

    blob(name, request) {
      const target = targets.resolve(name, 'azureBlob');
      const operations = target.allowedOperations ?? DEFAULT_BLOB_OPERATIONS;
      if (!operations.includes(request.operation))
        throw policyError(`Operation "${request.operation}" is not allowed for target "${name}".`);
      if (!target.allowedContainers.includes(request.container))
        throw policyError(`Container "${request.container}" is not allowed for target "${name}".`);
      assertBlobName(request.blobName);
      if (
        target.allowedBlobPrefixes &&
        !target.allowedBlobPrefixes.some((prefix) => request.blobName.startsWith(prefix))
      )
        throw policyError(
          `Blob "${request.blobName}" is outside the allowed prefixes of "${name}".`,
        );
      return {
        target,
        operation: request.operation,
        container: request.container,
        blobName: request.blobName,
        accountHost: new URL(target.accountUrl).host.toLowerCase(),
      };
    },

    serviceBus(name, request) {
      const target = targets.resolve(name, 'azureServiceBus');
      const operation = request.operation ?? 'send';
      // `inspect` (peeking) is never implied: it must be listed explicitly.
      const operations = target.allowedOperations ?? ['send'];
      if (!operations.includes(operation))
        throw policyError(`Operation "${operation}" is not allowed for target "${name}".`);
      if (!target.allowedEntities.includes(request.entity))
        throw policyError(`Entity "${request.entity}" is not allowed for target "${name}".`);
      const fullyQualifiedNamespace = serviceBusNamespaceHost(target);
      if (!fullyQualifiedNamespace)
        throw policyError(`Target "${name}" has no namespace configured.`);
      return { target, entity: request.entity, fullyQualifiedNamespace };
    },

    sql(name, request) {
      const target = targets.resolve(name, 'sqlServer');
      const analysis = analyzeSqlStatement(request.statement, request.kind, target.database);
      const operations = target.allowedOperations ?? DEFAULT_SQL_OPERATIONS;
      if (!operations.includes(analysis.operation))
        throw policyError(`Operation "${analysis.operation}" is not allowed for target "${name}".`);
      if (target.allowedSchemas) {
        const allowed = target.allowedSchemas.map((schema) => schema.toLowerCase());
        for (const table of analysis.tables)
          if (!allowed.includes(table.schema.toLowerCase()))
            throw policyError(`Schema "${table.schema}" is not allowed for target "${name}".`);
      }
      return {
        target,
        operation: analysis.operation,
        ...sqlServerHost(target),
        database: target.database,
        parameters: analysis.parameters,
      };
    },
  };
};

// --- Connection-string host binding -----------------------------------------------------------

const parseConnectionString = (value: string): Map<string, string> => {
  const parts = new Map<string, string>();
  for (const segment of value.split(';')) {
    const index = segment.indexOf('=');
    if (index > 0)
      parts.set(segment.slice(0, index).trim().toLowerCase(), segment.slice(index + 1).trim());
  }
  return parts;
};

/**
 * A resolved connection string must point at the host the Environment approved, so a secret
 * reference cannot redirect traffic to a different namespace or account. The message never
 * includes any part of the connection string.
 */
export const assertConnectionStringMatches = (
  kind: 'azureServiceBus' | 'azureBlob' | 'sqlServer',
  connectionString: string,
  expectedHost: string,
  expectedDatabase?: string,
): void => {
  const parts = parseConnectionString(connectionString);
  const expected = expectedHost.toLowerCase();
  let actual: string | undefined;
  if (kind === 'azureServiceBus') {
    const endpoint = parts.get('endpoint');
    if (endpoint) {
      try {
        actual = new URL(endpoint.replace(/^sb:\/\//i, 'https://')).host.toLowerCase();
      } catch {
        actual = undefined;
      }
    }
  } else if (kind === 'sqlServer') {
    const raw = ['server', 'data source', 'address', 'addr', 'network address']
      .map((key) => parts.get(key))
      .find((value) => value !== undefined);
    actual = raw
      ?.replace(/^(tcp|np|lpc):/i, '')
      .split(',')[0]
      ?.trim()
      .toLowerCase();
    if (expectedDatabase !== undefined) {
      const database = parts.get('database') ?? parts.get('initial catalog');
      if (database !== undefined && database.toLowerCase() !== expectedDatabase.toLowerCase())
        throw policyError(
          'The resolved connection string does not point at the database configured for this target.',
        );
    }
  } else {
    const endpoint = parts.get('blobendpoint');
    const account = parts.get('accountname');
    if (endpoint) {
      try {
        actual = new URL(endpoint).host.toLowerCase();
      } catch {
        actual = undefined;
      }
    } else if (account) {
      actual = expected.startsWith(`${account.toLowerCase()}.`)
        ? expected
        : `${account.toLowerCase()}.`;
    }
  }
  if (actual !== expected)
    throw policyError(
      'The resolved connection string does not point at the host configured for this target.',
    );
};
