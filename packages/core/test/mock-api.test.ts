import { describe, expect, it } from 'vitest';
import type { MockSetupAsset } from '@test-platform/contracts';
import {
  MockApiRegistry,
  compileMockSetups,
  matchMockRule,
  mockPathProblem,
} from '../src/index.js';

const setup = (id: string, rules: MockSetupAsset['rules']): MockSetupAsset => ({
  schemaVersion: 1,
  id,
  version: 1,
  name: `Setup ${id}`,
  tags: [],
  metadata: { createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'test' },
  rules,
});

describe('mock path patterns', () => {
  it('accepts regular expressions in any part of the path', () => {
    for (const path of ['/orders', '/orders/[0-9]+', '/users/[^/]+/items', '/files/.*', '/a|/b'])
      expect(mockPathProblem(path)).toBeUndefined();
  });

  it('rejects paths that are not usable', () => {
    expect(mockPathProblem('orders')).toContain('start with');
    expect(mockPathProblem('/orders/(')).toContain('regular expression');
    expect(mockPathProblem('/a/(x+)+')).toContain('extremely slow');
  });
});

describe('matching', () => {
  const rules = compileMockSetups([
    setup('a', [
      { path: '/orders/[0-9]+', method: 'GET', status: 200, body: { id: 1 } },
      { path: '/orders', status: 201 },
      { path: '/users/[^/]+/items', status: 200, body: [] },
    ]),
  ]);

  it('anchors the whole path and honours the method', () => {
    expect(matchMockRule(rules, 'GET', '/orders/42')?.ruleIndex).toBe(0);
    expect(matchMockRule(rules, 'POST', '/orders/42')).toBeUndefined();
    expect(matchMockRule(rules, 'POST', '/orders')?.ruleIndex).toBe(1);
    expect(matchMockRule(rules, 'GET', '/orders/42/lines')).toBeUndefined();
    expect(matchMockRule(rules, 'GET', '/users/7/items')?.ruleIndex).toBe(2);
    expect(matchMockRule(rules, 'GET', '/users/7/8/items')).toBeUndefined();
  });

  it('answers with the first matching rule', () => {
    const first = compileMockSetups([
      setup('a', [{ path: '/x/.*', status: 200 }]),
      setup('b', [{ path: '/x/y', status: 500 }]),
    ]);
    expect(matchMockRule(first, 'GET', '/x/y')?.rule.status).toBe(200);
  });
});

describe('MockApiRegistry', () => {
  it('serves only the Runs that are active, in the order they started', () => {
    const registry = new MockApiRegistry();
    registry.register('run-1', [setup('a', [{ path: '/ping', status: 200, body: { from: 1 } }])]);
    registry.register('run-2', [setup('b', [{ path: '/ping', status: 202, body: { from: 2 } }])]);
    expect(registry.match('GET', '/ping')).toMatchObject({ status: 200, body: '{"from":1}' });
    registry.unregister('run-1');
    expect(registry.match('GET', '/ping')).toMatchObject({ status: 202 });
    registry.unregister('run-2');
    expect(registry.match('GET', '/ping')).toBeUndefined();
    expect(registry.activeRuns).toEqual([]);
  });

  it('sends no body for a rule without one', () => {
    const registry = new MockApiRegistry();
    registry.register('r', [setup('a', [{ path: '/empty', status: 204 }])]);
    expect(registry.match('DELETE', '/empty')?.body).toBeUndefined();
  });

  it('matches the query string when the pattern has a query part', () => {
    const registry = new MockApiRegistry();
    registry.register('r', [
      setup('a', [
        { path: "/v1/Service?$filter=LocationId eq '[0-9]+'", status: 200 },
        { path: '/items?', status: 201 },
      ]),
    ]);
    const filter = "$filter=LocationId eq '0000023568'";
    expect(registry.match('GET', '/v1/Service', `?${filter}`)).toMatchObject({ status: 200 });
    expect(
      registry.match('GET', '/v1/Service', '?$filter=LocationId%20eq%20%270001%27'),
    ).toMatchObject({ status: 200 });
    expect(registry.match('GET', '/v1/Service', '?$filter=other')).toBeUndefined();
    expect(registry.match('GET', '/v1/Service')).toBeUndefined();
    // No "=" after the "?", so it is still a quantifier and the query is ignored.
    expect(registry.match('GET', '/items', '?page=2')).toMatchObject({ status: 201 });
    expect(mockPathProblem("/v1/Service?$filter=LocationId eq '(['")).toContain(
      'regular expression',
    );
  });
});
