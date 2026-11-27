import { describe, expect, it, vi } from 'vitest'
import type { Node } from '@xyflow/react'
import { focusBoxBack, nodeForKey } from './nodeKey'

// A Resource Graph box takes the keyboard focus (React Flow's node `div`, tabIndex 0) but Enter only selected it:
// onNodeClick hears presses of the pointer only. Now Enter opens what a press opens.
const raw = (name: string) => ({ id: name, kind: 'Deployment', name, namespace: 'shop', status: 'Available' })
const nodes: Node[] = [
  { id: 'n-web', position: { x: 0, y: 0 }, data: { raw: raw('web') } },
  { id: 'n-bare', position: { x: 0, y: 0 }, data: {} },
]
// the focused element and what it is inside of
const at = (cls: string | null, id: string | null) => {
  const el = { focus: vi.fn(), isConnected: true, getAttribute: (name: string) => (name === 'data-id' ? id : null), closest: (s: string) => (s === cls ? el : null) }
  return el
}

describe('nodeForKey', () => {
  it('opens the box that has the focus on Enter, and hands back that box to focus again', () => {
    const target = at('.react-flow__node', 'n-web')
    expect(nodeForKey({ key: 'Enter', isComposing: false, target }, nodes)).toEqual({ raw: raw('web'), element: target })
  })

  it('opens nothing for Space or Escape (React Flow selects with them), an input method composing, a line, a box without an object or no box', () => {
    const target = at('.react-flow__node', 'n-web')
    expect(nodeForKey({ key: ' ', target }, nodes)).toBeNull()
    expect(nodeForKey({ key: 'Escape', target }, nodes)).toBeNull()
    expect(nodeForKey({ key: 'Enter', isComposing: true, target }, nodes)).toBeNull()
    expect(nodeForKey({ key: 'Enter', target: at('.react-flow__edge', 'n-web') }, nodes)).toBeNull()
    expect(nodeForKey({ key: 'Enter', target: at('.react-flow__node', 'n-bare') }, nodes)).toBeNull()
    expect(nodeForKey({ key: 'Enter', target: at('.react-flow__node', 'gone') }, nodes)).toBeNull()
    expect(nodeForKey({ key: 'Enter', target: null }, nodes)).toBeNull()
  })

  it('opens nothing for an element drawn inside the box that has the focus itself', () => {
    const box = at('.react-flow__node', 'n-web')
    const inside = { closest: (s: string) => (s === '.react-flow__node' ? box : null) }
    expect(nodeForKey({ key: 'Enter', target: inside }, nodes)).toBeNull()
  })
})

describe('focusBoxBack', () => {
  const body = {}
  it('focuses the box again when the drawer took the focus with it', () => {
    const box = at('.react-flow__node', 'n-web')
    expect(focusBoxBack({ activeElement: body, body }, box)).toBe('box')
    expect(box.focus).toHaveBeenCalledOnce()
    expect(focusBoxBack({ activeElement: null, body }, box)).toBe('box')
  })

  it('leaves a focus put somewhere else meanwhile, and does nothing for a box gone or none', () => {
    const box = at('.react-flow__node', 'n-web')
    expect(focusBoxBack({ activeElement: {}, body }, box)).toBe('stay')
    expect(box.focus).not.toHaveBeenCalled()
    box.isConnected = false
    expect(focusBoxBack({ activeElement: body, body }, box)).toBe('none')
    expect(box.focus).not.toHaveBeenCalled()
    expect(focusBoxBack({ activeElement: body, body }, null)).toBe('none')
  })
})
