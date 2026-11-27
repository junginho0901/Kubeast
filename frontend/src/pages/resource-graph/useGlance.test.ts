import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Node } from '@xyflow/react'
import { fakeRender, fakeUnmount } from '@/testing/fakeHooks'
import { fakeDocument } from '@/testing/fakeDocument'
import type { ResourceGraphNode } from '@/services/api'

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : '') }) }))

import { glanceAt, useGlance } from './useGlance'
import { Glance } from './Glance'

// The Resource Graph's glance beside a box showed on hover only: Escape left it, it took no pointer and sat 16px from
// the box, so the pointer moving onto it lost it, and a box with the keyboard focus showed none. WCAG 2.2 1.4.13.
const { install, pressKey } = fakeDocument()
beforeEach(install)
afterEach(() => {
  fakeUnmount()
  vi.unstubAllGlobals()
})

const raw = (name: string, kind = 'Deployment') => ({ id: name, kind, name, namespace: 'shop', status: 'Running' }) as unknown as ResourceGraphNode
const node = (name: string, kind?: string): Node => ({ id: `n-${name}`, position: { x: 0, y: 0 }, data: { raw: raw(name, kind) } })
const nodes = [node('web'), node('db'), node('outside', 'TrafficPeer')]
const box = (right: number, top: number, id?: string) => {
  const el = {
    getBoundingClientRect: () => ({ right, top }),
    getAttribute: (name: string) => (name === 'data-id' ? id ?? null : null),
    closest: (selector: string) => (selector === '.react-flow__node' && id ? el : null),
  }
  return el
}
const render = () => fakeRender(() => useGlance(nodes))

describe('glanceAt', () => {
  it('places the glance at the box’s right edge and top, and gives a peer none', () => {
    expect(glanceAt(nodes[0], box(300, 120))).toEqual({ node: nodes[0].data.raw, x: 300, y: 120 })
    expect(glanceAt(nodes[2], box(300, 120))).toBeNull()
    expect(glanceAt(undefined, box(300, 120))).toBeNull()
  })
})

describe('useGlance', () => {
  it('shows the box the pointer came onto, at that box, not at the part of it the pointer came in over', () => {
    render().onNodeMouseEnter({ currentTarget: box(300, 120) }, nodes[0])
    const g = render().shown
    expect(g?.node.name).toBe('web')
    expect([g?.x, g?.y]).toEqual([300, 120])
  })

  it('stays while the pointer moves from the box onto the glance', () => {
    const first = render()
    first.onNodeMouseEnter({ currentTarget: box(300, 120) }, nodes[0])
    const g = render()
    g.onNodeMouseLeave()
    g.tip.onMouseEnter()
    expect(render().shown?.node.name).toBe('web')
    render().tip.onMouseLeave()
    expect(render().shown).toBeNull()
  })

  it('shows the box with the keyboard focus, and none once the focus leaves the boxes', () => {
    render().onFocus({ target: box(500, 40, 'n-db') })
    expect(render().shown?.node.name).toBe('db')
    render().onBlur()
    expect(render().shown).toBeNull()
    render().onFocus({ target: box(500, 40, 'n-outside') })
    expect(render().shown, 'a peer has no glance').toBeNull()
    render().onFocus({ target: box(500, 40) })
    expect(render().shown, 'focus on something that is not a box').toBeNull()
  })

  it('hides on Escape with the pointer still on the box, and the traffic panel or drawer hears nothing of it', () => {
    render().onNodeMouseEnter({ currentTarget: box(300, 120) }, nodes[1])
    expect(render().shown?.node.name).toBe('db')
    expect(pressKey('Escape')).toHaveBeenCalledTimes(1)
    expect(render().shown).toBeNull()
  })
})

describe('Glance', () => {
  it('takes the pointer, reaches back to the box’s edge and hands its pointer to the hook', () => {
    const onMouseEnter = () => {}
    const onMouseLeave = () => {}
    const el = Glance({ node: raw('web'), position: { x: 300, y: 120 }, onMouseEnter, onMouseLeave }) as unknown as { props: Record<string, unknown> }
    const classes = String(el.props.className).split(/\s+/)
    expect(classes).not.toContain('pointer-events-none')
    // the card starts 16px right of the box; its ::before fills those 16px
    expect(el.props.style).toEqual({ left: 316, top: 110 })
    expect(classes).toEqual(expect.arrayContaining(['before:absolute', 'before:inset-y-0', 'before:-left-4', 'before:w-4']))
    expect(el.props.onMouseEnter).toBe(onMouseEnter)
    expect(el.props.onMouseLeave).toBe(onMouseLeave)
  })
})
