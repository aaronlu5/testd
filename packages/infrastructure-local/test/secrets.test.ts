import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecretReference } from '@test-platform/contracts';
import { PlatformError, REDACTED, redactText, toErrorInfo } from '@test-platform/core';
import {
  AzureKeyVaultSecretProvider,
  ChainedSecretProvider,
  LocalPlainTextSecretProvider,
  assertSecretsFilePermissions,
  normalizeSecretName,
  openLocalInfrastructure,
  parseKeyVaultReference,
  secretEnvVarName,
  type KeyVaultSecretClient,
} from '../src/index.js';
import { cleanupAll, makeTempDir, onCleanup } from './helpers.js';

afterEach(cleanupAll);

// Test-only values, shaped like real credentials so masking is exercised.
const SB_CONNECTION =
  'Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=send;SharedAccessKey=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==';
const SB_KEY = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==';
const API_KEY = 'apikey-0123456789abcdef';
const VAULT = 'https://orders-kv.vault.azure.net';

const local = (name: string): SecretReference => ({
  type: 'secretReference',
  provider: 'localPlainText',
  name,
});
const vault = (name: string): SecretReference => ({
  type: 'secretReference',
  provider: 'keyVault',
  name,
});

const thrown = async (work: () => Promise<unknown>): Promise<PlatformError> => {
  try {
    await work();
  } catch (error) {
    return error as PlatformError;
  }
  throw new Error('expected the call to throw');
};

describe('secret name normalization', () => {
  it('maps names to TEST_PLATFORM_SECRET_<NORMALIZED_NAME>', () => {
    expect(normalizeSecretName('orders-service-bus-connection')).toBe(
      'ORDERS_SERVICE_BUS_CONNECTION',
    );
    expect(secretEnvVarName('orders-service-bus-connection')).toBe(
      'TEST_PLATFORM_SECRET_ORDERS_SERVICE_BUS_CONNECTION',
    );
  });
});

describe('LocalPlainTextSecretProvider', () => {
  it('reads the TEST_PLATFORM_SECRET_<NAME> environment variable', async () => {
    const provider = new LocalPlainTextSecretProvider({
      env: { TEST_PLATFORM_SECRET_ORDERS_SERVICE_BUS_CONNECTION: SB_CONNECTION },
    });
    expect(await provider.getSecret('orders-service-bus-connection')).toBe(SB_CONNECTION);
    expect(await provider.getSecret('Orders-Service-Bus-Connection')).toBe(SB_CONNECTION);
    expect(await provider.getSecret('absent')).toBeUndefined();
    expect(await provider.readiness('orders-service-bus-connection')).toBe('available');
    expect(await provider.readiness('absent')).toBe('missing');
  });

  it('treats empty variables as unset and rejects invalid or undeclared names', async () => {
    const provider = new LocalPlainTextSecretProvider({
      env: { TEST_PLATFORM_SECRET_EMPTY: '', TEST_PLATFORM_SECRET_OK: 'value-1234' },
      declaredNames: ['ok', 'empty'],
    });
    expect(await provider.getSecret('empty')).toBeUndefined();
    expect((await thrown(() => provider.getSecret('../etc'))).code).toBe('VALIDATION_REFERENCE');
    expect((await thrown(() => provider.getSecret('other'))).code).toBe('AUTH_FORBIDDEN');
  });

  it('falls back to the secrets file, with the environment taking precedence', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'secrets.local.json');
    await writeFile(
      file,
      JSON.stringify({ 'orders-api-key': 'from-file-123456', 'shared-name': 'file-wins-not' }),
    );
    await chmod(file, 0o600);
    const provider = new LocalPlainTextSecretProvider({
      env: { TEST_PLATFORM_SECRET_SHARED_NAME: 'env-wins-123456' },
      secretsFile: file,
    });
    expect(await provider.getSecret('orders-api-key')).toBe('from-file-123456');
    expect(await provider.getSecret('ORDERS_API_KEY')).toBe('from-file-123456');
    expect(await provider.getSecret('shared-name')).toBe('env-wins-123456');
    expect(provider.sensitiveValues()).toEqual(
      expect.arrayContaining(['env-wins-123456', 'from-file-123456']),
    );
  });

  it('ignores a secrets file that does not exist', async () => {
    const dir = await makeTempDir();
    const provider = new LocalPlainTextSecretProvider({
      env: {},
      secretsFile: join(dir, 'secrets.local.json'),
    });
    expect(await provider.getSecret('anything')).toBeUndefined();
  });

  it('rejects a malformed secrets file without echoing its content', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'secrets.local.json');
    const options = { env: {}, secretsFile: file, checkFilePermissions: () => undefined };

    await writeFile(file, `{"orders-api-key": "${API_KEY}" oops`);
    let error = await thrown(async () => new LocalPlainTextSecretProvider(options));
    expect(error.code).toBe('AUTH_SECRET_UNAVAILABLE');
    expect(`${error.message} ${error.detail ?? ''}`).not.toContain(API_KEY);

    for (const content of [`["${API_KEY}"]`, `{"k": 5}`, `{"bad name": "${API_KEY}"}`]) {
      await writeFile(file, content);
      error = await thrown(async () => new LocalPlainTextSecretProvider(options));
      expect(error.code).toBe('AUTH_SECRET_UNAVAILABLE');
      expect(error.message).not.toContain(API_KEY);
    }

    await writeFile(file, JSON.stringify({ 'a-b': 'value-aaaa', A_B: 'value-bbbb' }));
    error = await thrown(async () => new LocalPlainTextSecretProvider(options));
    expect(error.message).toContain('more than once');
    expect(error.message).not.toContain('value-aaaa');
  });

  it('enforces owner-only permissions where POSIX modes exist', () => {
    const stat = (mode: number) => () => ({ mode });
    expect(() =>
      assertSecretsFilePermissions('/x/secrets.local.json', {
        platform: 'linux',
        stat: stat(0o100644),
      }),
    ).toThrow('accessible to other users');
    expect(() =>
      assertSecretsFilePermissions('/x/secrets.local.json', {
        platform: 'linux',
        stat: stat(0o100660),
      }),
    ).toThrow();
    expect(() =>
      assertSecretsFilePermissions('/x/secrets.local.json', {
        platform: 'linux',
        stat: stat(0o100600),
      }),
    ).not.toThrow();
    // Windows modes are synthetic, so the host volume's ACLs are the control instead.
    expect(() =>
      assertSecretsFilePermissions('C:\\x\\secrets.local.json', {
        platform: 'win32',
        stat: stat(0o666),
      }),
    ).not.toThrow();
  });

  it('refuses to start when the permission check fails', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'secrets.local.json');
    await writeFile(file, JSON.stringify({ k: API_KEY }));
    const check = vi.fn(() => {
      throw new PlatformError('AUTH_FORBIDDEN', 'too broad');
    });
    expect(
      () =>
        new LocalPlainTextSecretProvider({
          env: {},
          secretsFile: file,
          checkFilePermissions: check,
        }),
    ).toThrow('too broad');
    expect(check).toHaveBeenCalledWith(file);
  });
});

describe('parseKeyVaultReference', () => {
  it('uses the default vault for bare names and the named vault for URIs', () => {
    expect(parseKeyVaultReference('orders-api-key', VAULT)).toEqual({
      vaultUrl: VAULT,
      secretName: 'orders-api-key',
    });
    const version = 'a'.repeat(32);
    expect(
      parseKeyVaultReference(`https://other.vault.azure.net/secrets/api-key/${version}`, undefined),
    ).toEqual({ vaultUrl: 'https://other.vault.azure.net', secretName: 'api-key', version });
  });

  it('rejects untrusted hosts, plain http, embedded credentials, and bad names', () => {
    const bad = [
      'https://evil.example.com/secrets/key',
      'https://user:pw@orders-kv.vault.azure.net/secrets/key',
      'https://orders-kv.vault.azure.net/keys/key',
      'https://orders-kv.vault.azure.net/secrets/bad_name',
      'not a name!',
    ];
    for (const name of bad)
      expect(() => parseKeyVaultReference(name, VAULT)).toThrow(PlatformError);
    expect(() => parseKeyVaultReference('key', 'http://orders-kv.vault.azure.net')).toThrow(
      PlatformError,
    );
    expect(() => parseKeyVaultReference('key', undefined)).toThrow('No Key Vault URL');
  });
});

describe('AzureKeyVaultSecretProvider (fake client; no live Key Vault)', () => {
  const fakeClient = (values: Record<string, string | Error>) => {
    const getSecret = vi.fn(async (name: string) => {
      const value = values[name];
      if (value instanceof Error) throw value;
      return { value };
    });
    const factory = vi.fn(async (): Promise<KeyVaultSecretClient> => ({ getSecret }));
    return { getSecret, factory };
  };

  it('reads a secret and builds one client per vault', async () => {
    const { getSecret, factory } = fakeClient({
      'orders-api-key': API_KEY,
      other: 'other-value-1',
    });
    const provider = new AzureKeyVaultSecretProvider({
      defaultVaultUrl: VAULT,
      clientFactory: factory,
    });
    expect(await provider.getSecret('orders-api-key')).toBe(API_KEY);
    expect(await provider.getSecret('other')).toBe('other-value-1');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(VAULT);
    expect(getSecret).toHaveBeenCalledWith('orders-api-key', undefined);
    expect(provider.sensitiveValues()).toEqual(expect.arrayContaining([API_KEY, 'other-value-1']));
  });

  it('returns undefined for a missing secret and hides SDK error details', async () => {
    const notFound = Object.assign(new Error(`not found: ${API_KEY}`), { statusCode: 404 });
    const forbidden = Object.assign(new Error(`GET ${VAULT}/secrets/x token=${API_KEY}`), {
      statusCode: 403,
    });
    const { factory } = fakeClient({ gone: notFound, locked: forbidden, boom: new Error(API_KEY) });
    const provider = new AzureKeyVaultSecretProvider({
      defaultVaultUrl: VAULT,
      clientFactory: factory,
    });
    expect(await provider.getSecret('gone')).toBeUndefined();

    for (const name of ['locked', 'boom']) {
      const error = await thrown(() => provider.getSecret(name));
      expect(error.code).toBe('AUTH_SECRET_UNAVAILABLE');
      const info = JSON.stringify(toErrorInfo(error));
      expect(info).not.toContain(API_KEY);
      expect(info).not.toContain('token=');
      expect(error.cause).toBeUndefined();
    }
  });

  it('reports readiness from configuration alone, never contacting the vault', async () => {
    const { getSecret, factory } = fakeClient({});
    const provider = new AzureKeyVaultSecretProvider({
      defaultVaultUrl: VAULT,
      clientFactory: factory,
    });
    expect(await provider.readiness('orders-api-key')).toBe('configured');
    expect(await new AzureKeyVaultSecretProvider({ clientFactory: factory }).readiness('x')).toBe(
      'unconfigured',
    );
    expect(factory).not.toHaveBeenCalled();
    expect(getSecret).not.toHaveBeenCalled();
  });
});

describe('ChainedSecretProvider', () => {
  const build = (
    env: Record<string, string | undefined>,
    kvValues: Record<string, string> = {},
    options: { withKeyVault?: boolean } = {},
  ) => {
    const getSecret = vi.fn(async (name: string) => ({ value: kvValues[name] }));
    const sources = [new LocalPlainTextSecretProvider({ env })];
    if (options.withKeyVault !== false) {
      sources.push(
        new AzureKeyVaultSecretProvider({
          defaultVaultUrl: VAULT,
          clientFactory: async () => ({ getSecret }),
        }) as never,
      );
    }
    return { chain: new ChainedSecretProvider(sources), getSecret };
  };

  it('answers each reference only from the provider it names', async () => {
    const { chain } = build(
      { TEST_PLATFORM_SECRET_ORDERS_SB: SB_CONNECTION },
      { 'orders-api-key': API_KEY },
    );
    expect(await chain.resolve(local('orders-sb'))).toBe(SB_CONNECTION);
    expect(await chain.resolve(vault('orders-api-key'))).toBe(API_KEY);
  });

  it('never falls back from keyVault to localPlainText', async () => {
    // The same name exists locally; the keyVault reference must still fail.
    const { chain, getSecret } = build({ TEST_PLATFORM_SECRET_ORDERS_API_KEY: API_KEY }, {});
    const error = await thrown(() => chain.resolve(vault('orders-api-key')));
    expect(error.code).toBe('AUTH_SECRET_UNAVAILABLE');
    expect(error.message).toContain('not found in provider "keyVault"');
    expect(error.message).not.toContain(API_KEY);
    expect(getSecret).toHaveBeenCalledTimes(1);
  });

  it('never falls back from localPlainText to keyVault', async () => {
    const { chain, getSecret } = build({}, { 'orders-sb': SB_CONNECTION });
    const error = await thrown(() => chain.resolve(local('orders-sb')));
    expect(error.message).toContain('not found in provider "localPlainText"');
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('fails clearly when the named provider is not configured', async () => {
    const { chain } = build(
      { TEST_PLATFORM_SECRET_ORDERS_API_KEY: API_KEY },
      {},
      { withKeyVault: false },
    );
    const error = await thrown(() => chain.resolve(vault('orders-api-key')));
    expect(error.message).toBe('Secret provider "keyVault" is not configured.');
    expect(await chain.checkReadiness(vault('orders-api-key'))).toBe('unconfigured');
  });

  it('checks readiness without fetching remote secrets or returning values', async () => {
    const { chain, getSecret } = build({ TEST_PLATFORM_SECRET_ORDERS_SB: SB_CONNECTION });
    expect(await chain.checkReadiness(local('orders-sb'))).toBe('available');
    expect(await chain.checkReadiness(local('absent'))).toBe('missing');
    expect(await chain.checkReadiness(vault('orders-api-key'))).toBe('configured');
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('keeps the Phase 1 name-only lookup on localPlainText', async () => {
    const { chain } = build({ TEST_PLATFORM_SECRET_ORDERS_API_KEY: API_KEY });
    expect(await chain.getSecret('orders-api-key')).toBe(API_KEY);
    expect(await chain.getSecret('absent')).toBeUndefined();
  });

  it('rejects duplicate provider registration', () => {
    expect(
      () =>
        new ChainedSecretProvider([
          new LocalPlainTextSecretProvider({ env: {} }),
          new LocalPlainTextSecretProvider({ env: {} }),
        ]),
    ).toThrow('registered more than once');
  });

  it('registers resolved values and connection-string parts as sensitive', async () => {
    const { chain } = build({}, { 'orders-sb': SB_CONNECTION });
    expect(chain.sensitiveValues()).not.toContain(SB_KEY);
    await chain.resolve(vault('orders-sb'));
    expect(chain.sensitiveValues()).toEqual(expect.arrayContaining([SB_CONNECTION, SB_KEY]));
  });
});

describe('masking of connection-string-shaped secrets', () => {
  it('masks a registered connection string, its key on its own, and unregistered look-alikes', async () => {
    const { chain } = (() => {
      const env = { TEST_PLATFORM_SECRET_ORDERS_SB: SB_CONNECTION };
      return { chain: new ChainedSecretProvider([new LocalPlainTextSecretProvider({ env })]) };
    })();
    const secrets = chain.sensitiveValues();

    const whole = redactText(`Sending with ${SB_CONNECTION} now`, secrets);
    expect(whole).not.toContain(SB_KEY);
    expect(whole).not.toContain('sb://');
    expect(whole).toContain(REDACTED);

    // The key alone (for example in an SDK error) is masked because its part was registered.
    expect(redactText(`auth failed for key ${SB_KEY}`, secrets)).not.toContain(SB_KEY);

    // A different connection string was never registered, but its shape is still masked.
    const unknown =
      'Endpoint=sb://other.servicebus.windows.net/;SharedAccessKey=bm90cmVnaXN0ZXJlZA==';
    expect(redactText(`using ${unknown}`, [])).not.toContain('bm90cmVnaXN0ZXJlZA==');
  });

  it('keeps secrets out of logs, audit metadata, and serialized error info', async () => {
    const dir = await makeTempDir();
    const lines: string[] = [];
    const infra = openLocalInfrastructure({
      runtimeDir: join(dir, 'runtime'),
      definitionsDir: join(dir, 'definitions'),
      env: { TEST_PLATFORM_SECRET_ORDERS_SB: SB_CONNECTION, TEST_PLATFORM_SECRET_API: API_KEY },
      logSink: (line) => lines.push(line),
    });
    onCleanup(() => infra.close());

    infra.logger.info(`connecting with ${SB_CONNECTION}`, {
      detail: `key=${SB_KEY}`,
      headers: { 'x-api-key': API_KEY, note: `token ${API_KEY}` },
    });
    await infra.audit.append({
      actor: 'tester',
      action: 'test',
      entityType: 'run',
      entityId: 'r1',
      metadata: { echoed: SB_CONNECTION },
    });

    const logged = lines.join('\n');
    for (const secret of [SB_CONNECTION, SB_KEY, API_KEY]) {
      expect(logged).not.toContain(secret);
      const audit = JSON.stringify(infra.db.prepare('SELECT metadata FROM audit_events').all());
      expect(audit).not.toContain(secret);
    }
    expect(logged).toContain(REDACTED);

    const resolved = await infra.secrets.resolve(local('orders-sb'));
    expect(resolved).toBe(SB_CONNECTION);
    const info = JSON.stringify(
      toErrorInfo(new PlatformError('AUTH_CREDENTIAL', 'Failed', { detail: 'bad credential' })),
    );
    expect(info).not.toContain(SB_CONNECTION);
  });

  it('wires the secrets file and Key Vault URL from options and the environment', async () => {
    const dir = await makeTempDir();
    const runtimeDir = join(dir, 'runtime');
    const file = join(runtimeDir, 'secrets.local.json');
    const getSecret = vi.fn(async () => ({ value: API_KEY }));

    const first = openLocalInfrastructure({
      runtimeDir,
      definitionsDir: join(dir, 'definitions'),
      env: { TEST_PLATFORM_KEY_VAULT_URL: VAULT },
      keyVaultClientFactory: async () => ({ getSecret }),
      logSink: () => undefined,
    });
    first.close();
    await writeFile(file, JSON.stringify({ 'orders-sb': SB_CONNECTION }));
    await chmod(file, 0o600);

    const infra = openLocalInfrastructure({
      runtimeDir,
      definitionsDir: join(dir, 'definitions'),
      env: { TEST_PLATFORM_KEY_VAULT_URL: VAULT },
      keyVaultClientFactory: async () => ({ getSecret }),
      logSink: () => undefined,
    });
    onCleanup(() => infra.close());
    expect(await infra.secrets.resolve(local('orders-sb'))).toBe(SB_CONNECTION);
    expect(await infra.secrets.resolve(vault('orders-api-key'))).toBe(API_KEY);
    expect(getSecret).toHaveBeenCalledWith('orders-api-key', undefined);
  });
});
