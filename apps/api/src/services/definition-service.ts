import { randomUUID } from 'node:crypto';
import {
  ASSET_SCHEMA_VERSION,
  SUPPORTED_TEST_SCHEMA_VERSIONS,
  TEST_SCHEMA_VERSION,
  type AssetOf,
  type AssetType,
  type SuiteAsset,
  type ValidationIssue,
} from '@test-platform/contracts';
import {
  PlatformError,
  globalReferenceProblems,
  mockPathProblem,
  type AssetSummary,
  type AssetVersionRecord,
  type AuditLog,
  type Clock,
  type DefinitionRepository,
  type SaveAssetInput,
  type StoredAsset,
} from '@test-platform/core';
import { notFound } from '../errors.js';
import { normalizeCandidate, type ApiWarning, type NormalizationReport } from './layout.js';
import { reportToError, type ValidationService } from './validation-service.js';

const AUTHORED_KEYS: Record<AssetType, readonly string[]> = {
  test: ['name', 'description', 'tags', 'variables', 'nodes', 'edges', 'editor', 'helpers'],
  'test-data': ['name', 'description', 'tags', 'data'],
  suite: ['name', 'description', 'tags', 'items', 'maxConcurrency', 'helpers'],
  'mock-setup': ['name', 'description', 'tags', 'rules'],
};

/** A saved asset plus anything the server normalized or wants the author to notice. */
export type SavedAsset<T extends AssetType = AssetType> = StoredAsset<T> & {
  warnings: ApiWarning[];
  normalization?: NormalizationReport;
};

const SERVER_OWNED = ['id', 'version', 'metadata', 'schemaVersion'] as const;

export type DefinitionServiceDeps = {
  definitions: DefinitionRepository;
  audit: AuditLog;
  validation: ValidationService;
  clock: Clock;
};

/** Test Data may only reference known global variables; this finds every string that does not. */
const globalReferenceIssues = (value: unknown, path: string): ValidationIssue[] => {
  if (typeof value === 'string')
    return globalReferenceProblems(value).map((message) => ({
      path,
      message,
      keyword: 'expression',
    }));
  if (Array.isArray(value))
    return value.flatMap((item, index) => globalReferenceIssues(item, `${path}/${index}`));
  if (typeof value === 'object' && value !== null)
    return Object.entries(value).flatMap(([key, item]) =>
      globalReferenceIssues(item, `${path}/${key}`),
    );
  return [];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Authoring operations for Tests, Test Data, and Suites on top of the shared definition repository. */
export class DefinitionService {
  readonly #deps: DefinitionServiceDeps;

  constructor(deps: DefinitionServiceDeps) {
    this.#deps = deps;
  }

  list(type: AssetType, filter: { tag?: string; search?: string } = {}): Promise<AssetSummary[]> {
    return this.#deps.definitions.list(type, filter);
  }

  async get<T extends AssetType>(type: T, id: string, version?: number): Promise<StoredAsset<T>> {
    const stored = await this.#deps.definitions.get(type, id, version);
    if (!stored)
      throw notFound(
        version === undefined
          ? `${label(type)} "${id}"`
          : `${label(type)} "${id}" version ${version}`,
      );
    return stored;
  }

  async versions(type: AssetType, id: string): Promise<AssetVersionRecord[]> {
    await this.get(type, id);
    return this.#deps.definitions.listVersions(type, id);
  }

  async create<T extends AssetType>(type: T, body: unknown, actor: string): Promise<SavedAsset<T>> {
    const draft = this.#draft(type, body, { id: randomUUID() });
    // New Tests whose nodes carry positions are position-sequenced from the start.
    if (type === 'test' && !('editor' in draft) && hasPositions(draft)) {
      draft.editor = { layoutDirection: 'vertical', autoSequenceFromPosition: true };
      draft.schemaVersion = TEST_SCHEMA_VERSION;
    }
    const stored = await this.#save(type, draft, actor, undefined);
    await this.#audit(actor, `${type}.create`, stored);
    return stored;
  }

  async update<T extends AssetType>(
    type: T,
    id: string,
    body: unknown,
    actor: string,
  ): Promise<SavedAsset<T>> {
    if (!isRecord(body) || !Number.isInteger(body.version) || (body.version as number) < 1) {
      throw schemaError('/version', 'is required and must be the version being edited');
    }
    const current = await this.get(type, id);
    const draft = this.#draft(type, body, { id });
    // An update that omits `editor` keeps the stored layout settings instead of downgrading them.
    if (type === 'test' && !('editor' in body)) {
      const stored = (current.asset as { editor?: unknown }).editor;
      if (stored !== undefined) {
        draft.editor = stored;
        draft.schemaVersion = TEST_SCHEMA_VERSION;
      }
    }
    const stored = await this.#save(type, draft, actor, body.version as number);
    await this.#audit(actor, `${type}.update`, stored);
    return stored;
  }

  async remove(type: Exclude<AssetType, 'suite'>, id: string, actor: string): Promise<void> {
    await this.get(type, id);
    const referencing = await this.#suitesReferencing(type, id);
    if (referencing.length > 0) {
      throw new PlatformError(
        'VALIDATION_CONFLICT',
        `${label(type)} "${id}" is used by ${referencing.length} ${type === 'mock-setup' ? 'Test(s) or Suite(s)' : 'Suite(s)'} and cannot be deleted.`,
      );
    }
    await this.#deps.definitions.delete(type, id, actor);
    await this.#deps.audit.append({
      actor,
      action: `${type}.delete`,
      entityType: type,
      entityId: id,
    });
  }

  #draft(type: AssetType, body: unknown, server: { id: string }): Record<string, unknown> {
    if (!isRecord(body)) throw schemaError('', 'must be a JSON object');
    const issues: ValidationIssue[] = [];
    const allowedVersions: readonly unknown[] =
      type === 'test' ? SUPPORTED_TEST_SCHEMA_VERSIONS : [ASSET_SCHEMA_VERSION];
    for (const key of ['metadata', 'schemaVersion'] as const) {
      if (
        key in body &&
        !(key === 'schemaVersion' && allowedVersions.includes(body.schemaVersion))
      ) {
        issues.push({ path: `/${key}`, message: 'is assigned by the server', keyword: 'readOnly' });
      }
    }
    if ('id' in body && body.id !== server.id) {
      issues.push({
        path: '/id',
        message: 'is assigned by the server and cannot be changed',
        keyword: 'readOnly',
      });
    }
    if (issues.length > 0)
      throw new PlatformError('VALIDATION_SCHEMA', 'The request body is not valid.', { issues });

    const draft: Record<string, unknown> = { schemaVersion: ASSET_SCHEMA_VERSION, id: server.id };
    if (type === 'test') {
      // Version 2 is implied by editor settings; an explicit schemaVersion is honoured and checked.
      draft.schemaVersion =
        typeof body.schemaVersion === 'number'
          ? body.schemaVersion
          : 'editor' in body
            ? TEST_SCHEMA_VERSION
            : ASSET_SCHEMA_VERSION;
    }
    for (const key of AUTHORED_KEYS[type]) if (key in body) draft[key] = body[key];
    for (const key of Object.keys(body)) {
      if (!AUTHORED_KEYS[type].includes(key) && !(SERVER_OWNED as readonly string[]).includes(key))
        draft[key] = body[key];
    }
    draft.tags ??= [];
    if (type === 'test') draft.variables ??= {};
    if (type === 'mock-setup' && Array.isArray(draft.rules)) {
      const problems = draft.rules.flatMap((rule: unknown, index: number): ValidationIssue[] => {
        const path = isRecord(rule) && typeof rule.path === 'string' ? rule.path : undefined;
        const problem = path === undefined ? undefined : mockPathProblem(path);
        return problem
          ? [{ path: `/rules/${index}/path`, message: problem, keyword: 'pattern' }]
          : [];
      });
      if (problems.length > 0)
        throw new PlatformError('VALIDATION_SCHEMA', 'A rule path is not usable.', {
          issues: problems,
        });
    }
    if (type === 'test-data') {
      const problems = globalReferenceIssues(draft.data, '/data');
      if (problems.length > 0)
        throw new PlatformError(
          'VALIDATION_SCHEMA',
          'The Test Data uses a reference that is not available.',
          { issues: problems },
        );
    }
    return draft;
  }

  async #save<T extends AssetType>(
    type: T,
    draft: Record<string, unknown>,
    actor: string,
    expectedVersion: number | undefined,
  ): Promise<SavedAsset<T>> {
    const now = this.#deps.clock.now().toISOString();
    let warnings: ApiWarning[] = [];
    let normalization: NormalizationReport | undefined;
    // The server derives the edges of a position-managed Test, so clients may leave them out.
    if (
      type === 'test' &&
      isRecord(draft.editor) &&
      draft.editor.autoSequenceFromPosition === true &&
      !Array.isArray(draft.edges)
    ) {
      draft.edges = [];
    }
    const candidate = {
      ...draft,
      version: expectedVersion === undefined ? 1 : expectedVersion + 1,
      metadata: { createdAt: now, createdBy: actor },
    };

    if (type === 'test') {
      // The server owns the order of a position-managed Test: edges are regenerated, then checked.
      const normalized = normalizeCandidate(candidate);
      warnings = normalized.warnings;
      normalization = normalized.normalization;
      if (normalized.normalization) {
        draft.edges = (normalized.candidate as { edges: unknown }).edges;
      }
      const report = this.#deps.validation.validateTest(normalized.candidate);
      if (!report.valid) throw reportToError(report, 'The Test is not valid and was not saved.');
    }
    if (type === 'suite') await this.#checkSuiteReferences(draft as unknown as SuiteAsset);
    if (type === 'test' || type === 'suite') await this.#checkHelperReferences(draft);

    const stored = await this.#deps.definitions.save(type, draft as SaveAssetInput<T>, {
      actor,
      expectedVersion,
    });
    return { ...stored, warnings, ...(normalization ? { normalization } : {}) };
  }

  /** A Test or Suite may only name Mock API setups that exist. */
  async #checkHelperReferences(draft: Record<string, unknown>): Promise<void> {
    const helpers = isRecord(draft.helpers) ? draft.helpers : undefined;
    const mockApi = helpers && isRecord(helpers.mockApi) ? helpers.mockApi : undefined;
    const ids = mockApi && Array.isArray(mockApi.setupIds) ? mockApi.setupIds : [];
    const issues: ValidationIssue[] = [];
    for (const [index, id] of ids.entries()) {
      if (!(await this.#deps.definitions.get('mock-setup', String(id))))
        issues.push({
          path: `/helpers/mockApi/setupIds/${index}`,
          message: 'refers to a Mock API setup that does not exist',
          keyword: 'reference',
        });
    }
    if (issues.length > 0)
      throw new PlatformError('VALIDATION_REFERENCE', 'The helpers refer to missing setups.', {
        issues,
      });
  }

  async #checkSuiteReferences(suite: Pick<SuiteAsset, 'items'>): Promise<void> {
    const issues: ValidationIssue[] = [];
    if (Array.isArray(suite.items)) {
      for (const [index, item] of suite.items.entries()) {
        const test = await this.#deps.definitions.get(
          'test',
          String(item.testId),
          item.testVersion,
        );
        if (!test)
          issues.push({
            path: `/items/${index}/testId`,
            message: 'refers to a Test that does not exist',
            keyword: 'reference',
          });
        const data = await this.#deps.definitions.get(
          'test-data',
          String(item.dataSetId),
          item.dataSetVersion,
        );
        if (!data)
          issues.push({
            path: `/items/${index}/dataSetId`,
            message: 'refers to Test Data that does not exist',
            keyword: 'reference',
          });
      }
    }
    if (issues.length > 0)
      throw new PlatformError('VALIDATION_REFERENCE', 'The Suite refers to missing assets.', {
        issues,
      });
  }

  async #usersOfMockSetup(id: string): Promise<string[]> {
    const found: string[] = [];
    for (const type of ['test', 'suite'] as const) {
      for (const summary of await this.#deps.definitions.list(type)) {
        const asset = (await this.#deps.definitions.get(type, summary.id))?.asset as
          { helpers?: { mockApi?: { setupIds?: string[] } } } | undefined;
        if (asset?.helpers?.mockApi?.setupIds?.includes(id)) found.push(`${type} ${summary.id}`);
      }
    }
    return found;
  }

  async #suitesReferencing(type: AssetType, id: string): Promise<string[]> {
    if (type === 'mock-setup') return this.#usersOfMockSetup(id);
    if (type === 'suite') return [];
    const found: string[] = [];
    for (const summary of await this.#deps.definitions.list('suite')) {
      const suite = await this.#deps.definitions.get('suite', summary.id);
      const field = type === 'test' ? 'testId' : 'dataSetId';
      if (suite?.asset.items.some((item) => item[field] === id)) found.push(summary.id);
    }
    return found;
  }

  async #audit(actor: string, action: string, stored: StoredAsset): Promise<void> {
    const asset = stored.asset as AssetOf<AssetType>;
    await this.#deps.audit.append({
      actor,
      action,
      entityType: stored.type,
      entityId: asset.id,
      metadata: { version: asset.version, name: asset.name },
    });
  }
}

const label = (type: AssetType): string =>
  type === 'test'
    ? 'Test'
    : type === 'test-data'
      ? 'Test Data'
      : type === 'mock-setup'
        ? 'Mock API setup'
        : 'Suite';

const schemaError = (path: string, message: string): PlatformError =>
  new PlatformError('VALIDATION_SCHEMA', 'The request body is not valid.', {
    issues: [{ path, message }],
  });

const hasPositions = (draft: Record<string, unknown>): boolean =>
  Array.isArray(draft.nodes) &&
  draft.nodes.length > 0 &&
  draft.nodes.every(
    (node) =>
      isRecord(node) && isRecord(node.position) && 'x' in node.position && 'y' in node.position,
  );
