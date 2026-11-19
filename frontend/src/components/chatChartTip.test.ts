import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { elementsOf, fakeRender, fakeUnmount, textsOf } from '@/testing/fakeHooks'
import { fakeDocument } from '@/testing/fakeDocument'
import type { ChatChartData } from '@/utils/chatChart'

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))

import { Plot } from './ChatChart'

// A chat graph's values box showed on hover only: Escape left it, it took no pointer (so it slid away from a pointer
// moving onto it) and a keyboard never showed it. WCAG 2.2 1.4.13.
const { install, pressKey } = fakeDocument()
beforeEach(install)
afterEach(() => {
  fakeUnmount()
  vi.unstubAllGlobals()
})

type Props = Record<string, unknown>
const T0 = 1_700_000_000
const chart: ChatChartData = {
  title: 'Memory',
  unit: 'bytes',
  promql: 'sum(container_memory_working_set_bytes)',
  series: [
    { label: 'pod=api', points: [[T0, 100 * 1024 * 1024], [T0 + 60, 200 * 1024 * 1024], [T0 + 120, 300 * 1024 * 1024]] },
    { label: 'pod=web', points: [[T0, 10 * 1024 * 1024], [T0 + 60, 20 * 1024 * 1024], [T0 + 120, 30 * 1024 * 1024]] },
  ],
} as ChatChartData
const draw = () => fakeRender(() => Plot({ chart, width: 600, height: 220 }))
const one = (tree: unknown, match: (p: Props, type: unknown) => boolean) => elementsOf(tree, match)[0]?.props
const plot = (tree: unknown) => one(tree, (p) => p['data-testid'] === 'chat-chart-plot')!
const wrap = (tree: unknown) => (tree as { props: Props }).props
const box = (tree: unknown) => one(tree, (p) => p['data-testid'] === 'chat-chart-tooltip')
const boxText = () => {
  const b = box(draw())
  return b ? textsOf(b.children).join(' ') : null
}
// the pointer at a share of the plot's width (left margin 60, right 8)
const pointAt = (share: number) => {
  const move = plot(draw()).onMouseMove as (e: { currentTarget: { getBoundingClientRect(): { left: number } }; clientX: number }) => void
  move({ currentTarget: { getBoundingClientRect: () => ({ left: 0 }) }, clientX: 60 + share * 532 })
}

describe('a chat graph’s values box', () => {
  it('shows on hover where the pointer is and goes when the pointer leaves the graph', () => {
    ;(wrap(draw()).onMouseEnter as () => void)()
    pointAt(0)
    expect(boxText()).toContain('100 MiB')
    expect(boxText()).not.toContain('300 MiB')
    ;(wrap(draw()).onMouseLeave as () => void)()
    expect(boxText()).toBeNull()
  })

  it('takes the pointer, so a pointer moved onto it keeps it where it is', () => {
    ;(wrap(draw()).onMouseEnter as () => void)()
    pointAt(0.5)
    const classes = String(box(draw())!.className).split(/\s+/)
    expect(classes).not.toContain('pointer-events-none')
    expect(classes).toContain('absolute')
  })

  it('takes the keyboard focus and then shows the newest values, until the focus leaves', () => {
    const svg = plot(draw())
    expect(svg.tabIndex).toBe(0)
    expect(boxText()).toBeNull()
    ;(svg.onFocus as () => void)()
    expect(boxText()).toContain('pod=api')
    expect(boxText()).toContain('300 MiB')
    expect(boxText()).toContain('30 MiB')
    ;(plot(draw()).onBlur as () => void)()
    expect(boxText()).toBeNull()
  })

  it('hides on Escape with the pointer still on the graph, moving on it shows nothing, and leaving and coming back shows it', () => {
    ;(wrap(draw()).onMouseEnter as () => void)()
    pointAt(0.5)
    expect(boxText()).not.toBeNull()
    expect(pressKey('Escape'), 'the chat or the larger window around it hears nothing').toHaveBeenCalledTimes(1)
    expect(boxText()).toBeNull()
    pointAt(0.9)
    expect(boxText()).toBeNull()
    ;(wrap(draw()).onMouseLeave as () => void)()
    ;(wrap(draw()).onMouseEnter as () => void)()
    pointAt(0.9)
    expect(boxText()).toContain('300 MiB')
  })
})
