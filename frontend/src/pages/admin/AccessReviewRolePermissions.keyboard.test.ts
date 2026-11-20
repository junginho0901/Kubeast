import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { elementsOf, fakeRender, fakeUnmount } from '@/testing/fakeHooks'

// Exercise the real frame/overlay keyboard handlers without a browser or a DOM package.
const ui = vi.hoisted(() => ({ top: true, overlay: null as unknown, titleId: 'permissions-title' }))
vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks, useId: () => ui.titleId }))
vi.mock('react-dom', async (original) => ({
  ...(await original<typeof import('react-dom')>()),
  createPortal: (node: { props: { ref: { current: unknown } } }) => { node.props.ref.current = ui.overlay; return node },
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, options: { defaultValue: string }) => options.defaultValue }) }))
vi.mock('@/hooks/useModalStack', () => ({ useModalStackEntry: () => ({ isTop: () => ui.top, zIndex: 1200 }) }))

import { ModalFrame } from '@/components/ModalFrame'
import { ModalOverlay } from '@/components/ModalOverlay'

type Control = { focus: () => void; getClientRects: () => object[]; isConnected: boolean; compareDocumentPosition: (other: Control) => number }
let active: Control | null
let opener: Control
let first: Control
let last: Control
let order: Control[]
let listeners: Set<(event: unknown) => void>
const control = (): Control => {
  // in document order as made: Node.DOCUMENT_POSITION_FOLLOWING (4) or _PRECEDING (2)
  const el: Control = { focus: vi.fn(() => { active = el }), getClientRects: () => [{}], isConnected: true,
    compareDocumentPosition: (other) => (order.indexOf(other) > order.indexOf(el) ? 4 : 2) }
  order.push(el)
  return el
}
beforeEach(() => {
  ui.top = true
  listeners = new Set()
  order = []
  opener = control(); first = control(); last = control(); active = opener
  ui.overlay = { querySelectorAll: () => [first, last], contains: (el: unknown) => el === first || el === last }
  vi.stubGlobal('document', {
    body: {}, get activeElement() { return active },
    addEventListener: (_type: string, fn: (e: unknown) => void) => listeners.add(fn),
    removeEventListener: (_type: string, fn: (e: unknown) => void) => listeners.delete(fn),
  })
})
afterEach(() => { fakeUnmount(); vi.unstubAllGlobals() })

const mount = (onClose: () => void) => {
  // Render the shared frame first, then the overlay it actually returns.
  const frame = fakeRender(() => ModalFrame({ title: 'review-reader — Permissions', onClose, footer: null, children: 'admin.audit.read' }))
  expect(frame.type).toBe(ModalOverlay)
  const dialog = elementsOf(frame, (p) => p.role === 'dialog')[0]
  expect(dialog.props['aria-modal']).toBe('true')
  expect(dialog.props['aria-labelledby']).toBe(ui.titleId)
  return fakeRender(() => ModalOverlay(frame.props as { children: ReactNode; onClose: () => void }))
}
const key = (name: string, shiftKey = false, defaultPrevented = false) => {
  const event = { key: name, shiftKey, defaultPrevented, preventDefault: vi.fn(), stopPropagation: vi.fn() }
  for (const fn of listeners) fn(event)
  return event
}

describe('the permissions window uses ModalFrame keyboard behavior', () => {
  it('focuses its first control on open and restores the opener on close', () => {
    mount(vi.fn())
    expect(active).toBe(first)
    fakeUnmount()
    expect(active).toBe(opener)
    expect(listeners.size).toBe(0)
  })

  it('cycles Tab and Shift+Tab inside the top window', () => {
    const close = vi.fn()
    mount(close)
    active = last
    expect(key('Tab').preventDefault).toHaveBeenCalledOnce()
    expect(active).toBe(first)
    expect(key('Tab', true).preventDefault).toHaveBeenCalledOnce()
    expect(active).toBe(last)
    active = opener
    key('Tab')
    expect(active).toBe(first)
    expect(close).not.toHaveBeenCalled()
  })

  it('Escape closes only this top window and does not reach the drawer below', () => {
    const close = vi.fn()
    const drawer = vi.fn()
    mount(close)
    const e = key('Escape')
    if (!e.stopPropagation.mock.calls.length) drawer()
    expect(close).toHaveBeenCalledOnce()
    expect(e.stopPropagation).toHaveBeenCalledOnce()
    expect(drawer).not.toHaveBeenCalled()
  })

  it('leaves keys to a window above it and does not consume a handled Tab', () => {
    const close = vi.fn()
    mount(close)
    ui.top = false
    active = last
    expect(key('Escape').stopPropagation).not.toHaveBeenCalled()
    expect(key('Tab').preventDefault).not.toHaveBeenCalled()
    expect(active).toBe(last)
    expect(close).not.toHaveBeenCalled()
    ui.top = true
    expect(key('Tab', false, true).preventDefault).not.toHaveBeenCalled()
    expect(active).toBe(last)
  })
})
