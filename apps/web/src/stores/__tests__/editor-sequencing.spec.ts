import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { StepTypeMetadata, TestDefinition } from '~/api/types'
import { STEP_SPACING, sortByPosition } from '~/components/platform/position-sequence'
import { useEditorStore } from '~/stores/editor'

const type = (name: string): StepTypeMetadata => ({
  type: name,
  displayName: name[0]!.toUpperCase() + name.slice(1),
  configSchema: {},
  sensitivePaths: [],
  defaults: name === 'breakpoint' ? { enabled: true } : {},
  capabilities: { external: false, supportsRetry: false, supportsArtifacts: false },
})
const delay = type('delay')
const assertStep = type('assert')
const breakpoint = type('breakpoint')

const pairs = (store: ReturnType<typeof useEditorStore>) =>
  store.draft.edges.map((e) => `${e.from}>${e.to}`)

const freshStore = () => {
  setActivePinia(createPinia())
  const store = useEditorStore()
  store.reset()
  return store
}

beforeEach(() => setActivePinia(createPinia()))

describe('position-driven editing', () => {
  it('starts new Tests position-driven and appends Steps below the last one', () => {
    const store = freshStore()
    expect(store.positionDriven).toBe(true)
    const a = store.addStep(delay)
    const b = store.addStep(breakpoint)
    const c = store.addStep(assertStep)
    expect(store.draft.nodes.map((n) => n.position?.y)).toEqual([0, STEP_SPACING, STEP_SPACING * 2])
    expect(pairs(store)).toEqual([`${a}>${b}`, `${b}>${c}`])
    expect(store.draft.edges.every((e) => e.metadata?.systemManaged)).toBe(true)
    expect(store.order).toEqual([a, b, c])
    expect(store.analysis.valid).toBe(true)
  })

  it('regenerates connections when a Step is dragged above another', () => {
    const store = freshStore()
    const a = store.addStep(delay)
    const b = store.addStep(delay)
    const c = store.addStep(assertStep)

    expect(store.dropStep(c, { x: 0, y: -400 })).toBe(true)
    expect(store.order).toEqual([c, a, b])
    expect(pairs(store)).toEqual([`${c}>${a}`, `${a}>${b}`])
    expect(sortByPosition(store.draft.nodes)).toEqual([c, a, b])
    expect(store.announcement).toMatch(/moved from position 3 to position 1; connections updated\./)
  })

  it('does not reorder for a nudge within the threshold, and keeps the Step above its neighbour', () => {
    const store = freshStore()
    const a = store.addStep(delay)
    const b = store.addStep(delay)
    expect(store.dropStep(a, { x: 0, y: STEP_SPACING + 2 })).toBe(false)
    expect(store.order).toEqual([a, b])
    expect(store.draft.nodes.find((n) => n.id === a)!.position!.y).toBeLessThan(STEP_SPACING)
    expect(sortByPosition(store.draft.nodes)).toEqual([a, b])
    expect(pairs(store)).toEqual([`${a}>${b}`])
  })

  it('moves a Step earlier or later from the keyboard', () => {
    const store = freshStore()
    const a = store.addStep(delay)
    const b = store.addStep(delay)
    expect(store.moveStep(a, 1)).toBe(true)
    expect(store.order).toEqual([b, a])
    expect(store.announcement).toBe(
      'Delay moved from position 1 to position 2; connections updated.',
    )
    expect(store.moveStep(a, 1)).toBe(false) // already last
    expect(store.moveStep(b, -1)).toBe(false) // already first
  })

  it('removes a Step and reconnects its neighbours', () => {
    const store = freshStore()
    const a = store.addStep(delay)
    const b = store.addStep(breakpoint)
    const c = store.addStep(assertStep)
    store.removeStep(b)
    expect(pairs(store)).toEqual([`${a}>${c}`])
  })

  it('does not accept hand-drawn connections', () => {
    const store = freshStore()
    const a = store.addStep(delay)
    const b = store.addStep(delay)
    const result = store.connect(b, a)
    expect(result.ok).toBe(false)
    expect(pairs(store)).toEqual([`${a}>${b}`])
    store.disconnect(a, b)
    expect(pairs(store)).toEqual([`${a}>${b}`])
  })

  it('sends the editor settings, positions and connections to the API', () => {
    const store = freshStore()
    store.draft.name = 'Flow'
    store.addStep(delay)
    store.addStep(delay)
    const body = store.toRequestBody()
    expect(body.editor).toEqual({ layoutDirection: 'vertical', autoSequenceFromPosition: true })
    expect(body.nodes.every((n) => n.position !== undefined)).toBe(true)
    expect(body.edges).toHaveLength(1)
  })
})

describe('undo and redo', () => {
  it('undoes and redoes a drag before save', () => {
    const store = freshStore()
    const a = store.addStep(delay)
    const b = store.addStep(delay)
    const c = store.addStep(assertStep)
    const original = JSON.stringify(store.draft.nodes.map((n) => [n.id, n.position]))

    store.dropStep(c, { x: 0, y: -400 })
    expect(store.order).toEqual([c, a, b])
    expect(store.canUndo).toBe(true)

    expect(store.undo()).toBe(true)
    expect(store.order).toEqual([a, b, c])
    expect(JSON.stringify(store.draft.nodes.map((n) => [n.id, n.position]))).toBe(original)
    expect(pairs(store)).toEqual([`${a}>${b}`, `${b}>${c}`])
    expect(store.canRedo).toBe(true)

    expect(store.redo()).toBe(true)
    expect(store.order).toEqual([c, a, b])
    expect(pairs(store)).toEqual([`${c}>${a}`, `${a}>${b}`])
    expect(store.canRedo).toBe(false)
  })

  it('walks back through several changes, including adds and removes', () => {
    const store = freshStore()
    const a = store.addStep(delay)
    const b = store.addStep(delay)
    store.moveStep(b, -1)
    store.removeStep(a)
    expect(store.draft.nodes.map((n) => n.id)).toEqual([b])

    store.undo() // restores a
    expect(store.order).toEqual([b, a])
    store.undo() // undoes the move
    expect(store.order).toEqual([a, b])
    store.undo() // undoes adding b
    expect(store.draft.nodes.map((n) => n.id)).toEqual([a])
    store.undo() // undoes adding a
    expect(store.draft.nodes).toEqual([])
    expect(store.canUndo).toBe(false)
    expect(store.undo()).toBe(false)
  })

  it('a new change clears the redo history', () => {
    const store = freshStore()
    const a = store.addStep(delay)
    store.addStep(delay)
    store.undo()
    expect(store.canRedo).toBe(true)
    store.addStep(assertStep)
    expect(store.canRedo).toBe(false)
    void a
  })

  it('keeps parameters edited since the change when undoing a layout move', () => {
    const store = freshStore()
    const a = store.addStep(delay)
    const b = store.addStep(delay)
    store.moveStep(a, 1)
    store.updateStep(b, { name: 'Renamed' })
    store.undo()
    expect(store.draft.nodes.find((n) => n.id === b)?.name).toBe('Renamed')
    expect(store.order).toEqual([a, b])
  })

  it('has no history after loading or saving: only the saved layout remains', () => {
    const store = freshStore()
    store.draft.name = 'Flow'
    const a = store.addStep(delay)
    const b = store.addStep(delay)
    store.moveStep(a, 1)
    expect(store.canUndo).toBe(true)

    // The server answers with its own (authoritative) layout.
    const saved: TestDefinition = {
      schemaVersion: 2,
      id: 'test-1',
      version: 1,
      name: 'Flow',
      tags: [],
      metadata: { createdAt: 'x', createdBy: 'y' },
      variables: {},
      editor: { layoutDirection: 'vertical', autoSequenceFromPosition: true },
      nodes: [
        { ...store.draft.nodes.find((n) => n.id === b)!, position: { x: 0, y: 0 } },
        { ...store.draft.nodes.find((n) => n.id === a)!, position: { x: 0, y: 500 } },
      ],
      edges: [{ from: b, to: a, metadata: { systemManaged: true } }],
    }
    store.markSaved(saved)
    expect(store.canUndo).toBe(false)
    expect(store.canRedo).toBe(false)
    expect(store.dirty).toBe(false)
    expect(store.draft.nodes.find((n) => n.id === a)?.position).toEqual({ x: 0, y: 500 })
    expect(store.version).toBe(1)
  })

  it('treats the server-normalized layout as authoritative after save', () => {
    const store = freshStore()
    store.draft.name = 'Flow'
    const a = store.addStep(delay)
    const b = store.addStep(delay)
    // The server disagrees with the local preview and returns the opposite order.
    store.markSaved({
      schemaVersion: 2,
      id: 't',
      version: 3,
      name: 'Flow',
      tags: [],
      metadata: { createdAt: 'x', createdBy: 'y' },
      variables: {},
      editor: { layoutDirection: 'vertical', autoSequenceFromPosition: true },
      nodes: [
        { id: a, type: 'delay', name: 'Delay', parameters: {}, position: { x: 0, y: 140 } },
        { id: b, type: 'delay', name: 'Delay', parameters: {}, position: { x: 0, y: 0 } },
      ],
      edges: [{ from: b, to: a, metadata: { systemManaged: true } }],
    })
    expect(store.order).toEqual([b, a])
    expect(pairs(store)).toEqual([`${b}>${a}`])
  })
})

describe('opting an existing Test in', () => {
  const legacy: TestDefinition = {
    schemaVersion: 2,
    id: 'legacy',
    version: 4,
    name: 'Legacy',
    tags: [],
    metadata: { createdAt: 'x', createdBy: 'y' },
    variables: {},
    editor: { layoutDirection: 'vertical', autoSequenceFromPosition: false },
    nodes: [
      { id: 'a', type: 'delay', name: 'A', parameters: {} },
      { id: 'b', type: 'delay', name: 'B', parameters: {} },
      { id: 'c', type: 'delay', name: 'C', parameters: {} },
    ],
    edges: [
      { from: 'c', to: 'a' },
      { from: 'a', to: 'b' },
    ],
  }

  it('loads as manual and keeps the stored edges', () => {
    const store = freshStore()
    store.load(legacy)
    expect(store.positionDriven).toBe(false)
    expect(pairs(store)).toEqual(['c>a', 'a>b'])
    expect(store.order).toEqual(['c', 'a', 'b'])
    expect(store.draft.nodes.every((n) => n.position === undefined)).toBe(true)
    expect(store.dirty).toBe(false)
  })

  it('re-spaces a Test saved with cramped Steps when it is loaded, without marking it edited', () => {
    const store = freshStore()
    const cramped = {
      ...legacy,
      schemaVersion: 2,
      editor: { layoutDirection: 'vertical', autoSequenceFromPosition: true },
      nodes: legacy.nodes.map((n, index) => ({ ...n, position: { x: 0, y: index * 100 } })),
      edges: [],
    } as unknown as Parameters<typeof store.load>[0]
    store.load(cramped)
    const ys = store.draft.nodes.map((n) => n.position!.y).sort((a, b) => a - b)
    expect(ys).toEqual([0, STEP_SPACING, STEP_SPACING * 2])
    expect(store.dirty).toBe(false)
    expect(store.order).toEqual(sortByPosition(cramped.nodes))
  })

  it('previews the resulting order and connections without changing anything', () => {
    const store = freshStore()
    store.load(legacy)
    const preview = store.conversionPreview()
    expect(preview.newOrder).toEqual(['c', 'a', 'b'])
    expect(preview.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['c>a', 'a>b'])
    expect(preview.appended).toEqual([])
    expect(preview.connectionsChange).toBe(false)
    expect(store.positionDriven).toBe(false)
    expect(store.dirty).toBe(false)
  })

  it('flags Steps that were not connected and will be appended', () => {
    const store = freshStore()
    store.load({ ...legacy, edges: [{ from: 'c', to: 'a' }] })
    const preview = store.conversionPreview()
    expect(preview.appended).toEqual(['b'])
    expect(preview.newOrder).toEqual(['c', 'a', 'b'])
    expect(preview.connectionsChange).toBe(true)
  })

  it('applies the switch as an undoable, unsaved change that preserves the order', () => {
    const store = freshStore()
    store.load(legacy)
    expect(store.enableSequencing()).toBe(true)
    expect(store.positionDriven).toBe(true)
    expect(store.order).toEqual(['c', 'a', 'b'])
    expect(store.draft.nodes.every((n) => n.position !== undefined)).toBe(true)
    expect(store.draft.edges.every((e) => e.metadata?.systemManaged)).toBe(true)
    expect(store.dirty).toBe(true)
    expect(store.enableSequencing()).toBe(false) // already on

    store.undo()
    expect(store.positionDriven).toBe(false)
    expect(pairs(store)).toEqual(['c>a', 'a>b'])
    expect(store.draft.nodes.every((n) => n.position === undefined)).toBe(true)
  })

  it('keeps manual behaviour for Tests that stay manual', () => {
    const store = freshStore()
    store.load(legacy)
    expect(store.moveStep('b', -1)).toBe(true)
    expect(store.order).toEqual(['c', 'b', 'a'])
    expect(store.draft.edges.some((e) => e.metadata?.systemManaged)).toBe(false)
    expect(store.dropStep('a', { x: 0, y: 0 })).toBe(false)
    expect(store.connect('b', 'c').ok).toBe(false) // would form a loop
  })
})

describe('Helpers on the Test draft', () => {
  it('saves the chosen Mock API setups, leaves helpers out when none, and loads them back', () => {
    const store = freshStore()
    store.draft.name = 'With mocks'
    expect(store.toRequestBody()).not.toHaveProperty('helpers')

    store.draft.mockSetupIds = ['a', 'b']
    expect(store.dirty).toBe(true)
    const body = store.toRequestBody()
    expect(body.helpers).toEqual({ mockApi: { setupIds: ['a', 'b'] } })

    const saved = {
      ...body,
      id: 't1',
      version: 1,
      schemaVersion: 2,
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'x' },
    } as unknown as TestDefinition
    store.markSaved(saved)
    expect(store.draft.mockSetupIds).toEqual(['a', 'b'])
    expect(store.dirty).toBe(false)
  })
})
