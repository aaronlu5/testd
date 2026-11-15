import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import type { StepTypeMetadata, TestEdge, TestNode } from '~/api/types'
import {
  addNode,
  analyzeGraph,
  canConnect,
  displayOrder,
  moveNode,
  removeNode,
  uniqueNodeId,
} from '~/components/platform/flow-graph'
import { useEditorStore } from '~/stores/editor'

const node = (id: string): TestNode => ({ id, type: 'delay', name: id, parameters: {} })
const nodes = (...ids: string[]) => ids.map(node)
const chain = (...ids: string[]): TestEdge[] =>
  ids.slice(1).map((to, i) => ({ from: ids[i] as string, to }))

describe('sequential graph restrictions', () => {
  it('accepts a single chain and returns its order', () => {
    const result = analyzeGraph(nodes('a', 'b', 'c'), chain('a', 'b', 'c'))
    expect(result).toMatchObject({ valid: true, order: ['a', 'b', 'c'] })
  })

  it('reports Steps that are not connected into one sequence', () => {
    const result = analyzeGraph(nodes('a', 'b', 'c'), chain('a', 'b'))
    expect(result.valid).toBe(false)
    expect(result.issues.map((i) => i.code)).toContain('FLOW_MULTIPLE_START')
  })

  it('reports branching, merging and loops', () => {
    const fan = analyzeGraph(nodes('a', 'b', 'c'), [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
    ])
    expect(fan.issues.map((i) => i.code)).toContain('FLOW_FAN_OUT')

    const merge = analyzeGraph(nodes('a', 'b', 'c'), [
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' },
    ])
    expect(merge.issues.map((i) => i.code)).toContain('FLOW_FAN_IN')

    const loop = analyzeGraph(nodes('a', 'b'), chain('a', 'b').concat({ from: 'b', to: 'a' }))
    expect(loop.issues.map((i) => i.code)).toContain('FLOW_CYCLE')
  })

  it('requires at least one Step', () => {
    expect(analyzeGraph([], []).issues[0]?.code).toBe('FLOW_EMPTY')
  })

  describe('canConnect', () => {
    const base = nodes('a', 'b', 'c')

    it('allows extending a chain', () => {
      expect(canConnect(base, chain('a', 'b'), 'b', 'c')).toEqual({ ok: true })
    })

    it('refuses self connections, branches, merges and loops with a reason', () => {
      expect(canConnect(base, [], 'a', 'a')).toMatchObject({ ok: false })
      const branch = canConnect(base, chain('a', 'b'), 'a', 'c')
      expect(branch.ok ? '' : branch.reason).toMatch(/branching/)
      const merge = canConnect(base, chain('a', 'c'), 'b', 'c')
      expect(merge.ok ? '' : merge.reason).toMatch(/merging/)
      const loop = canConnect(base, chain('a', 'b', 'c'), 'c', 'a')
      expect(loop.ok ? '' : loop.reason).toMatch(/loop/)
    })

    it('refuses unknown Steps', () => {
      expect(canConnect(base, [], 'a', 'zzz')).toMatchObject({ ok: false })
    })
  })

  it('links a new Step after the last one of a valid chain', () => {
    const result = addNode(nodes('a', 'b'), chain('a', 'b'), node('c'))
    expect(result.edges).toEqual(chain('a', 'b', 'c'))
  })

  it('does not guess a position when the flow is not a chain yet', () => {
    const result = addNode(nodes('a', 'b'), [], node('c'))
    expect(result.edges).toEqual([])
  })

  it('bridges neighbours when a Step is deleted', () => {
    const result = removeNode(nodes('a', 'b', 'c'), chain('a', 'b', 'c'), 'b')
    expect(result.nodes.map((n) => n.id)).toEqual(['a', 'c'])
    expect(result.edges).toEqual([{ from: 'a', to: 'c' }])
  })

  it('reorders only inside a valid chain', () => {
    expect(moveNode(nodes('a', 'b', 'c'), chain('a', 'b', 'c'), 'c', -1)).toEqual(
      chain('a', 'c', 'b'),
    )
    expect(moveNode(nodes('a', 'b', 'c'), chain('a', 'b', 'c'), 'a', -1)).toBeUndefined()
    expect(moveNode(nodes('a', 'b', 'c'), chain('a', 'b'), 'a', 1)).toBeUndefined()
  })

  it('generates unique ids and a stable display order', () => {
    expect(uniqueNodeId(nodes('delay'), 'delay')).toBe('delay-2')
    expect(uniqueNodeId([], 'transform.json')).toBe('transform-json')
    expect(displayOrder(nodes('x', 'a', 'b'), chain('a', 'b'))).toEqual(['a', 'b', 'x'])
  })
})

describe('editor store', () => {
  const delayType: StepTypeMetadata = {
    type: 'delay',
    displayName: 'Delay',
    configSchema: {},
    sensitivePaths: [],
    defaults: { durationSeconds: 1 },
    capabilities: { external: false, supportsRetry: true, supportsArtifacts: false },
  }

  it('chains added Steps, tracks unsaved changes, and refuses invalid connections', () => {
    setActivePinia(createPinia())
    const store = useEditorStore()
    // The manual-connection rules still apply to Tests that have not opted in to position sequencing.
    store.reset({ editor: { layoutDirection: 'vertical', autoSequenceFromPosition: false } })
    const a = store.addStep(delayType)
    const b = store.addStep(delayType)
    expect(store.draft.edges).toEqual([{ from: a, to: b }])
    expect(store.dirty).toBe(true)
    expect(store.analysis.valid).toBe(true)

    const refused = store.connect(b, a)
    expect(refused.ok).toBe(false)
    expect(store.draft.edges).toHaveLength(1)

    expect(store.clientIssues.map((i) => i.message)).toContain('Give the Test a name.')
  })

  it('does not mutate the Step type defaults', () => {
    setActivePinia(createPinia())
    const store = useEditorStore()
    store.reset()
    const id = store.addStep(delayType)
    store.updateStep(id, { parameters: { durationSeconds: 5 } })
    expect(delayType.defaults).toEqual({ durationSeconds: 1 })
  })

  it('copes with reactive Step types, as served from the query cache', () => {
    setActivePinia(createPinia())
    const store = useEditorStore()
    store.reset()
    const id = store.addStep(reactive({ ...delayType, defaults: { durationSeconds: 1 } }))
    expect(store.draft.nodes.find((n) => n.id === id)?.parameters).toEqual({ durationSeconds: 1 })
  })
})
