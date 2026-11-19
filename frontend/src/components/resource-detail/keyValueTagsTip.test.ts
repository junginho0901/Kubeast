import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { elementsOf, fakeRender, fakeUnmount, textsOf } from '@/testing/fakeHooks'
import { fakeDocument } from '@/testing/fakeDocument'

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
vi.mock('./useDetailLabel', () => ({ useDetailLabel: () => (s: string) => s, useDetailSection: () => (s: string) => s }))

import { KeyValueTags } from './DetailCommon'

// A drawer tag's whole key and value (labels, annotations) showed on hover only: Escape left it, the pointer moving
// onto it lost it (it took no pointer and sat 4px under the tag), and a keyboard never reached it. WCAG 2.2 1.4.13.
const { install, pressKey } = fakeDocument()
beforeEach(install)
afterEach(() => {
  fakeUnmount()
  vi.unstubAllGlobals()
})

type Props = Record<string, unknown>
const data = { 'app.kubernetes.io/name': 'web', 'kubectl.kubernetes.io/last-applied-configuration': 'x'.repeat(400) }
const draw = () => fakeRender(() => KeyValueTags({ data }))
const tags = (tree: unknown) => elementsOf(tree, (p) => p['data-detail-tag'] === '').map((e) => e.props)
const tipOf = (tag: Props) => elementsOf(tag.children, (p) => p['data-detail-tag-tip'] === '')[0].props
const shown = (tag: Props) => String(tipOf(tag).className).split(/\s+/).includes('block')
const shownTips = () => tags(draw()).filter(shown).map((t) => textsOf(tipOf(t).children).join(''))

describe('a drawer tag’s whole value', () => {
  it('is hidden until the pointer or the focus comes, and the tag takes the keyboard focus', () => {
    const all = tags(draw())
    expect(all).toHaveLength(2)
    expect(all.map((t) => t.tabIndex)).toEqual([0, 0])
    expect(shownTips()).toEqual([])
  })

  it('shows on hover, keeps the parts the drawer checks read in place, and goes when the pointer leaves', () => {
    ;(tags(draw())[1].onMouseEnter as () => void)()
    expect(shownTips()).toEqual([`kubectl.kubernetes.io/last-applied-configuration: ${'x'.repeat(400)}`])
    const parts = (tags(draw())[1].children as unknown[]).filter(Boolean) as { type: string; props: Props }[]
    expect(parts.map((p) => p.type)).toEqual(['span', 'span', 'span', 'span'])
    expect(parts.map((p) => String(p.props.className).includes('truncate'))).toEqual([true, false, true, false])
    ;(tags(draw())[1].onMouseLeave as () => void)()
    expect(shownTips()).toEqual([])
  })

  it('shows for a pointer resting where the tag is drawn at its first move, and moving after Escape keeps it hidden', () => {
    ;(tags(draw())[0].onMouseMove as () => void)()
    expect(shownTips()).toEqual(['app.kubernetes.io/name: web'])
    pressKey('Escape')
    ;(tags(draw())[0].onMouseMove as () => void)()
    expect(shownTips()).toEqual([])
  })

  it('takes the pointer and touches the tag, so the pointer can move onto it', () => {
    const tip = tipOf(tags(draw())[0])
    const classes = String(tip.className).split(/\s+/)
    expect(classes).not.toContain('pointer-events-none')
    expect(classes).toContain('top-full')
    expect(classes, 'no margin between the tag and its tip').not.toContain('mt-1')
    expect(classes).toContain('pt-1')
    expect(tip['aria-hidden'], 'a screen reader reads the tag’s own whole text once').toBe('true')
  })

  it('shows on keyboard focus and goes on blur', () => {
    ;(tags(draw())[0].onFocus as () => void)()
    expect(shownTips()).toEqual(['app.kubernetes.io/name: web'])
    ;(tags(draw())[0].onBlur as () => void)()
    expect(shownTips()).toEqual([])
  })

  it('hides on Escape with the pointer still on it, and the drawer hears nothing of that key', () => {
    ;(tags(draw())[0].onMouseEnter as () => void)()
    expect(shownTips()).toHaveLength(1)
    expect(pressKey('Escape')).toHaveBeenCalledTimes(1)
    expect(shownTips()).toEqual([])
    expect(pressKey('Escape'), 'the next Escape is the drawer’s').not.toHaveBeenCalled()
  })
})
