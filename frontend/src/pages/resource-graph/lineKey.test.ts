import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import type { TrafficLine } from '@/services/api'
import { lineForKey } from './lineKey'

// A Resource Graph line takes the keyboard focus (React Flow's edge `g`, tabIndex 0) but Enter opened nothing:
// onEdgeClick hears presses of the pointer only, and React Flow itself only selects the line.
const line: TrafficLine = {
  from: { namespace: 'shop', kind: 'Deployment', name: 'web' },
  to: { namespace: 'shop', kind: 'Deployment', name: 'db' },
  allowed: 2,
  dropped: 0,
}
const edges: Edge[] = [
  { id: 'line-1', source: 'a', target: 'b', data: { line } },
  { id: 'owns-1', source: 'a', target: 'b', data: {} },
]
// the focused element and what it is inside of
const at = (cls: string | null, id: string | null) => {
  const g = { focus: () => {}, getAttribute: (name: string) => (name === 'data-id' ? id : null), closest: (s: string) => (s === cls ? g : null) }
  return g
}

describe('lineForKey', () => {
  it('opens the traffic line whose edge has the focus on Enter, and hands back that edge to focus again', () => {
    const target = at('.react-flow__edge', 'line-1')
    expect(lineForKey({ key: 'Enter', isComposing: false, target }, edges)).toEqual({ id: 'line-1', line, element: target })
  })

  it('opens nothing for another key, an input method composing, a line of the structure, a box or no line', () => {
    const target = at('.react-flow__edge', 'line-1')
    expect(lineForKey({ key: ' ', target }, edges)).toBeNull()
    expect(lineForKey({ key: 'Escape', target }, edges)).toBeNull()
    expect(lineForKey({ key: 'Enter', isComposing: true, target }, edges)).toBeNull()
    expect(lineForKey({ key: 'Enter', target: at('.react-flow__edge', 'owns-1') }, edges)).toBeNull()
    expect(lineForKey({ key: 'Enter', target: at('.react-flow__node', 'line-1') }, edges)).toBeNull()
    expect(lineForKey({ key: 'Enter', target: at('.react-flow__edge', 'gone') }, edges)).toBeNull()
    expect(lineForKey({ key: 'Enter', target: null }, edges)).toBeNull()
  })
})
