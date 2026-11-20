import { afterEach, describe, expect, it, vi } from 'vitest'
import { elementsOf, fakeRender, fakeUnmount } from '@/testing/fakeHooks'
import type { TrafficLine, TrafficResult } from '@/services/api'

// The traffic panel's X closed it and left the focus nowhere (Escape gave it back to the line), and the panel had no
// place inside it for the focus an Enter on a line moves there. Rendered with the fake hooks: what its X does and what
// its title is.
vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _key }) }))
vi.mock('@/hooks/useDismiss', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useDismiss')>()),
  usePanelEscape: () => {},
}))

import { TrafficPanel } from './TrafficPanel'

const line: TrafficLine = {
  from: { namespace: 'flows-demo', kind: 'Deployment', name: 'stranger' },
  to: { namespace: 'flows-demo', kind: 'Deployment', name: 'web' },
  allowed: 0,
  dropped: 3,
}
const result: TrafficResult = { available: true, source: 'relay', namespaces: ['flows-demo'], since: '5m', lines: [line] }

type Props = Record<string, unknown>
const panel = (props: Partial<Parameters<typeof TrafficPanel>[0]>) => fakeRender(() => TrafficPanel({
  line, result, opener: { current: null }, onClose: () => {}, onWhy: () => {}, onOpen: () => {}, ...props,
}))
const byTestId = (tree: unknown, id: string) => elementsOf(tree, (p) => p['data-testid'] === id)[0]?.props as Props | undefined

afterEach(() => fakeUnmount())

describe('Resource Graph traffic panel focus', () => {
  it('closes on its X and gives the focus back to the line, after the close as Escape does', () => {
    const order: string[] = []
    const opener = { current: { focus: vi.fn(() => { order.push('focus') }) } }
    const onClose = vi.fn(() => { order.push('close') })
    const close = byTestId(panel({ opener, onClose }), 'traffic-panel-close')
    ;(close?.onClick as () => void)()
    expect(onClose).toHaveBeenCalledOnce()
    expect(opener.current.focus).toHaveBeenCalledOnce()
    expect(order).toEqual(['close', 'focus'])
  })

  it('closes on its X with no line to give the focus to', () => {
    const onClose = vi.fn()
    const close = byTestId(panel({ opener: { current: null }, onClose }), 'traffic-panel-close')
    expect(() => (close?.onClick as () => void)()).not.toThrow()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('holds its title for the page to focus: out of the Tab order, with the console outline when the keyboard put it there', () => {
    const titleRef = { current: null }
    const title = byTestId(panel({ titleRef }), 'traffic-panel-title')
    expect(title?.ref).toBe(titleRef)
    expect(title?.tabIndex).toBe(-1)
    expect(String(title?.className).split(' ')).toEqual(expect.arrayContaining([
      'focus-visible:outline-2', 'focus-visible:outline-offset-2', 'focus-visible:outline-primary-400',
    ]))
    expect(title?.children).toBe('Traffic')
  })
})
