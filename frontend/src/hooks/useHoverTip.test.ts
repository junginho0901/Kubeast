import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeRender, fakeUnmount } from '@/testing/fakeHooks'
import { fakeDocument } from '@/testing/fakeDocument'
import { noTip, tipShown, tipStep, useHoverTip, type TipEvent, type TipState } from './useHoverTip'

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))

// Three hover boxes (the Resource Graph's glance, a drawer tag's whole value, a chat graph's values) stayed on Escape,
// went away when the pointer moved onto them and never came on the keyboard: WCAG 2.2 1.4.13.
const run = <T>(...events: TipEvent<T>[]) => events.reduce<TipState<T>>(tipStep, noTip)

describe('tipStep and tipShown', () => {
  it('shows what the pointer is on, and nothing once it left', () => {
    expect(tipShown(run({ type: 'enter', value: 'a' }))).toBe('a')
    expect(tipShown(run({ type: 'enter', value: 'a' }, { type: 'leave' }))).toBeNull()
  })

  it('stays while the pointer moves from its trigger onto it, and goes when it leaves that too', () => {
    const onTip = run<string>({ type: 'enter', value: 'a' }, { type: 'leave' }, { type: 'tipEnter' })
    expect(tipShown(onTip)).toBe('a')
    expect(tipShown(tipStep(onTip, { type: 'tipLeave' }))).toBeNull()
    expect(tipShown(run<string>({ type: 'enter', value: 'a' }, { type: 'tipEnter' }, { type: 'tipLeave' }, { type: 'leave' }))).toBeNull()
  })

  it('shows on keyboard focus, until the focus leaves', () => {
    expect(tipShown(run({ type: 'focus', value: 'b' }))).toBe('b')
    expect(tipShown(run({ type: 'focus', value: 'b' }, { type: 'blur' }))).toBeNull()
  })

  it('hides on Escape without the pointer or the focus moving, and a new hover or focus shows it again', () => {
    const hidden = run<string>({ type: 'enter', value: 'a' }, { type: 'escape' })
    expect(tipShown(hidden)).toBeNull()
    expect(tipShown(tipStep(hidden, { type: 'tipEnter' })), 'nothing to move onto while it is hidden').toBeNull()
    expect(tipShown(run<string>({ type: 'enter', value: 'a' }, { type: 'escape' }, { type: 'leave' }, { type: 'enter', value: 'a' }))).toBe('a')
    expect(tipShown(run<string>({ type: 'focus', value: 'b' }, { type: 'escape' }))).toBeNull()
    expect(tipShown(run<string>({ type: 'focus', value: 'b' }, { type: 'escape' }, { type: 'blur' }, { type: 'focus', value: 'c' }))).toBe('c')
    expect(tipShown(run<string>({ type: 'enter', value: 'a' }, { type: 'escape' }, { type: 'focus', value: 'c' }))).toBe('c')
  })

  it('changes nothing on enter again from the trigger the pointer is on, so a move after Escape keeps it hidden', () => {
    const hidden = run<string>({ type: 'enter', value: 'a' }, { type: 'escape' })
    expect(tipStep(hidden, { type: 'enter', value: 'a' })).toBe(hidden)
    expect(tipShown(tipStep(hidden, { type: 'enter', value: 'b' })), 'another trigger is a new hover').toBe('b')
  })

  it('shows the last of the pointer and the focus, and the other once that one leaves', () => {
    expect(tipShown(run<string>({ type: 'focus', value: 'b' }, { type: 'enter', value: 'a' }))).toBe('a')
    expect(tipShown(run<string>({ type: 'enter', value: 'a' }, { type: 'focus', value: 'b' }))).toBe('b')
    expect(tipShown(run<string>({ type: 'enter', value: 'a' }, { type: 'focus', value: 'b' }, { type: 'blur' }))).toBe('a')
    expect(tipShown(run<string>({ type: 'focus', value: 'b' }, { type: 'enter', value: 'a' }, { type: 'leave' }))).toBe('b')
  })
})

const { listeners, install, pressKey } = fakeDocument()
beforeEach(install)
afterEach(() => {
  fakeUnmount()
  vi.unstubAllGlobals()
})

describe('useHoverTip', () => {
  const render = () => fakeRender(() => useHoverTip<string>())

  it('listens for Escape only while something is shown, in capture, and the key goes no further', () => {
    let tip = render()
    expect(listeners).toHaveLength(0)
    tip.enter('a')
    tip = render()
    expect(tip.shown).toBe('a')
    expect(listeners.map((l) => [l.type, l.capture])).toEqual([['keydown', true]])

    expect(pressKey('Enter')).not.toHaveBeenCalled()
    expect(pressKey('Escape', true), 'an input method composing keeps its Escape').not.toHaveBeenCalled()
    expect(render().shown).toBe('a')

    const stop = pressKey('Escape')
    expect(stop, 'the drawer, window or chat around it hears nothing').toHaveBeenCalledTimes(1)
    tip = render()
    expect(tip.shown).toBeNull()
    expect(listeners, 'the next Escape is the page’s again').toHaveLength(0)
  })

  it('gives the tip its own pointer handlers and the trigger its focus', () => {
    let tip = render()
    tip.enter('a')
    tip.leave()
    tip.tip.onMouseEnter()
    tip = render()
    expect(tip.shown).toBe('a')
    tip.tip.onMouseLeave()
    tip.focus('b')
    tip = render()
    expect(tip.shown).toBe('b')
    tip.blur()
    expect(render().shown).toBeNull()
  })
})
