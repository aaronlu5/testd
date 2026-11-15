import { describe, expect, it } from 'vitest'
import type { TestNode } from '~/api/types'
import {
  DEFAULT_REORDER_THRESHOLD,
  NODE_HEIGHT,
  STEP_SPACING,
  applyDrop,
  describeMove,
  insertionY,
  layoutInOrder,
  MIN_STEP_GAP,
  nextPosition,
  relaxedPositions,
  resolveDrop,
  shiftStep,
  sortByPosition,
  systemEdges,
} from '~/components/platform/position-sequence'

const node = (id: string, y: number, x = 0): TestNode => ({
  id,
  type: 'delay',
  name: id,
  parameters: {},
  position: { x, y },
})
const stack = (...ids: string[]): TestNode[] =>
  ids.map((id, index) => node(id, index * STEP_SPACING))
const pairs = (edges: { from: string; to: string }[]) => edges.map((e) => `${e.from}>${e.to}`)

describe('sorting by position', () => {
  it('orders by y, then x, then node id', () => {
    expect(sortByPosition([node('c', 10), node('a', 30), node('b', 20)])).toEqual(['c', 'b', 'a'])
    expect(sortByPosition([node('a', 10, 50), node('b', 10, 5)])).toEqual(['b', 'a'])
  })

  it('breaks complete ties by node id, whatever the input order', () => {
    const ties = [node('z', 10, 5), node('m', 10, 5), node('b', 10, 5), node('B', 10, 5)]
    const expected = ['B', 'b', 'm', 'z'] // code-unit order, independent of locale
    expect(sortByPosition(ties)).toEqual(expected)
    expect(sortByPosition([...ties].reverse())).toEqual(expected)
    expect(sortByPosition([ties[2]!, ties[0]!, ties[3]!, ties[1]!])).toEqual(expected)
  })

  it('handles negative and fractional positions and does not mutate its input', () => {
    const input = [node('a', 0.5), node('b', -3), node('c', 0.25)]
    expect(sortByPosition(input)).toEqual(['b', 'c', 'a'])
    expect(input.map((n) => n.id)).toEqual(['a', 'b', 'c'])
  })

  it('generates one system-managed connection between each adjacent pair', () => {
    expect(systemEdges(['a', 'b', 'c'])).toEqual([
      { from: 'a', to: 'b', metadata: { systemManaged: true } },
      { from: 'b', to: 'c', metadata: { systemManaged: true } },
    ])
    expect(systemEdges(['only'])).toEqual([])
    expect(systemEdges([])).toEqual([])
  })
})

describe('midpoint threshold', () => {
  const three = stack('a', 'b', 'c') // y = 0, 140, 280

  it('does not reorder while the card has not crossed its neighbour by the threshold', () => {
    // Centre of "a" is at NODE_HEIGHT/2; b's centre is 140 lower. Move a nearly onto b.
    const nearlyThere = STEP_SPACING + DEFAULT_REORDER_THRESHOLD - 1
    expect(resolveDrop(three, 'a', nearlyThere)).toMatchObject({ moved: false, index: 0 })
    expect(resolveDrop(three, 'a', STEP_SPACING)).toMatchObject({ moved: false }) // exactly level
  })

  it('reorders once the centre passes the neighbour midpoint by more than the threshold', () => {
    const past = STEP_SPACING + DEFAULT_REORDER_THRESHOLD + 1
    expect(resolveDrop(three, 'a', past)).toMatchObject({
      order: ['b', 'a', 'c'],
      index: 1,
      moved: true,
    })
  })

  it('can pass several neighbours in one drag, in either direction', () => {
    expect(resolveDrop(three, 'a', 600).order).toEqual(['b', 'c', 'a'])
    expect(resolveDrop(three, 'c', -300).order).toEqual(['c', 'a', 'b'])
    expect(resolveDrop(three, 'c', STEP_SPACING - DEFAULT_REORDER_THRESHOLD - 1).order).toEqual([
      'a',
      'c',
      'b',
    ])
  })

  it('treats the threshold as configurable', () => {
    expect(resolveDrop(three, 'a', STEP_SPACING + 5, { threshold: 0 })).toMatchObject({
      moved: true,
    })
    expect(resolveDrop(three, 'a', STEP_SPACING + 5, { threshold: 50 })).toMatchObject({
      moved: false,
    })
  })

  it('reports unknown ids without reordering', () => {
    expect(resolveDrop(three, 'nope', 0)).toMatchObject({ index: -1, moved: false })
  })
})

describe('applying a drop', () => {
  it('moving a Step above another re-stacks every Step and reconnects each pair', () => {
    const result = applyDrop(stack('a', 'b', 'c'), 'c', { x: 0, y: -200 })
    expect(result.reordered).toBe(true)
    expect(result.order).toEqual(['c', 'a', 'b'])
    expect(pairs(result.edges)).toEqual(['c>a', 'a>b'])
    expect(result.nodes.map((n) => [n.id, n.position?.y])).toEqual([
      ['a', STEP_SPACING],
      ['b', STEP_SPACING * 2],
      ['c', 0],
    ])
    // The stored positions alone reproduce the same order (what the server will compute).
    expect(sortByPosition(result.nodes)).toEqual(result.order)
  })

  it('keeps each Step column (x) when re-stacking', () => {
    const nodes = [node('a', 0, 10), node('b', 140, 20)]
    const result = applyDrop(nodes, 'a', { x: 99, y: 400 })
    expect(Object.fromEntries(result.nodes.map((n) => [n.id, n.position?.x]))).toEqual({
      a: 99,
      b: 20,
    })
  })

  it('keeps a small adjustment without reordering and without crossing a neighbour', () => {
    const result = applyDrop(stack('a', 'b', 'c'), 'b', { x: 30, y: STEP_SPACING + 8 })
    expect(result.reordered).toBe(false)
    expect(result.nodes.find((n) => n.id === 'b')?.position).toEqual({ x: 30, y: STEP_SPACING + 8 })
    expect(sortByPosition(result.nodes)).toEqual(['a', 'b', 'c'])
  })

  it('clamps a within-threshold drop so the sort still yields the same order', () => {
    // Dropped almost on top of "c" but short of the threshold: it must stay above c.
    const result = applyDrop(stack('a', 'b', 'c'), 'b', { x: 0, y: STEP_SPACING * 2 + 5 })
    expect(result.reordered).toBe(false)
    expect(result.nodes.find((n) => n.id === 'b')?.position?.y).toBe(STEP_SPACING * 2 - 1)
    expect(sortByPosition(result.nodes)).toEqual(['a', 'b', 'c'])
  })

  it('resolves equal-y ties deterministically by x then id after a drop', () => {
    const tied = [node('b', 0, 0), node('a', 0, 0), node('c', 140)]
    const result = applyDrop(tied, 'c', { x: 0, y: 150 })
    expect(result.reordered).toBe(false)
    expect(result.order).toEqual(['a', 'b', 'c'])
  })

  it('is stable: dropping a Step where it already is changes nothing', () => {
    const start = stack('a', 'b', 'c')
    const result = applyDrop(start, 'b', { x: 0, y: STEP_SPACING })
    expect(result.reordered).toBe(false)
    expect(result.nodes).toEqual(start)
  })
})

describe('keyboard alternative', () => {
  it('moves a Step one place earlier or later and regenerates connections', () => {
    const later = shiftStep(stack('a', 'b', 'c'), 'a', 1)!
    expect(later.order).toEqual(['b', 'a', 'c'])
    expect(pairs(later.edges)).toEqual(['b>a', 'a>c'])
    expect(sortByPosition(later.nodes)).toEqual(['b', 'a', 'c'])

    const earlier = shiftStep(later.nodes, 'c', -1)!
    expect(earlier.order).toEqual(['b', 'c', 'a'])
  })

  it('refuses to move past the ends or an unknown Step', () => {
    expect(shiftStep(stack('a', 'b'), 'a', -1)).toBeUndefined()
    expect(shiftStep(stack('a', 'b'), 'b', 1)).toBeUndefined()
    expect(shiftStep(stack('a', 'b'), 'x', 1)).toBeUndefined()
  })
})

describe('layout helpers', () => {
  it('lays a sequence out top to bottom in a given order', () => {
    const update = layoutInOrder(
      [
        { id: 'a', type: 'delay', name: 'a', parameters: {} },
        { id: 'b', type: 'delay', name: 'b', parameters: {} },
      ],
      ['b', 'a'],
    )
    expect(update.nodes.map((n) => [n.id, n.position])).toEqual([
      ['a', { x: 0, y: STEP_SPACING }],
      ['b', { x: 0, y: 0 }],
    ])
    expect(pairs(update.edges)).toEqual(['b>a'])
  })

  it('places a new Step below the last one', () => {
    expect(nextPosition([])).toEqual({ x: 0, y: 0 })
    expect(nextPosition(stack('a', 'b'))).toEqual({ x: 0, y: STEP_SPACING * 2 })
  })

  it('puts the insertion marker in the gap where the Step would land', () => {
    const nodes = stack('a', 'b', 'c')
    const marker = insertionY(nodes, ['b', 'a', 'c'], 'a')
    // Between b (y 140, height 84) and c (y 280).
    expect(marker).toBe((STEP_SPACING + NODE_HEIGHT + STEP_SPACING * 2) / 2)
    expect(insertionY(nodes, ['a', 'b', 'c'], 'a')).toBe(STEP_SPACING - 12)
    expect(insertionY(nodes, ['b', 'c', 'a'], 'a')).toBe(STEP_SPACING * 2 + NODE_HEIGHT + 12)
  })

  it('describes moves for screen readers', () => {
    expect(describeMove('Verify status', 2, 1)).toBe(
      'Verify status moved from position 3 to position 2; connections updated.',
    )
    expect(describeMove('Verify status', 1, 1)).toBe('Verify status stays at position 2.')
  })
})

describe('relaxing a cramped layout', () => {
  it('leaves a comfortable layout alone', () => {
    expect(relaxedPositions(stack('a', 'b', 'c'))).toBeUndefined()
    expect(relaxedPositions([node('a', 0)])).toBeUndefined()
    expect(relaxedPositions([node('a', 0), node('b', MIN_STEP_GAP)])).toBeUndefined()
  })

  it('re-spaces Steps that sit closer than a card needs, keeping order and x', () => {
    // Older Tests were saved 100 or 140 apart, which left no room for the connection dots.
    const relaxed = relaxedPositions([node('a', 0, 10), node('b', 100, 20), node('c', 200, 30)])
    expect(relaxed).toEqual({
      a: { x: 10, y: 0 },
      b: { x: 20, y: STEP_SPACING },
      c: { x: 30, y: STEP_SPACING * 2 },
    })
    expect(relaxedPositions([node('a', 0), node('b', 140)])).toBeDefined()
  })

  it('never changes the execution order, even when positions tie', () => {
    const tied = [node('b', 0, 0), node('a', 0, 0), node('c', 10)]
    const relaxed = relaxedPositions(tied)!
    const moved = tied.map((n) => ({ ...n, position: relaxed[n.id] }))
    expect(sortByPosition(moved)).toEqual(sortByPosition(tied))
  })

  it('does nothing for Steps without positions (manual connections)', () => {
    expect(relaxedPositions([{ id: 'a' }, { id: 'b' }])).toBeUndefined()
  })
})
