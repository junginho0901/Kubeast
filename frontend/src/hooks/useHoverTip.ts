import { useCallback, useEffect, useState } from 'react'
import { dismissHandlers } from './useDismiss'

// Content that appears on pointer hover or keyboard focus, held to WCAG 2.2 1.4.13: Escape hides it without moving
// the pointer or the focus, the pointer can move from its trigger onto it, and it stays until the pointer and the
// focus have left both. `T` names what is shown (a tag's key, a graph box).

export type TipEvent<T> =
  | { type: 'enter'; value: T }
  | { type: 'leave' }
  | { type: 'tipEnter' }
  | { type: 'tipLeave' }
  | { type: 'focus'; value: T }
  | { type: 'blur' }
  | { type: 'escape' }

export interface TipState<T> {
  pointer: T | null
  onTrigger: boolean
  onTip: boolean
  focus: T | null
  lead: 'pointer' | 'focus'
  hidden: boolean
}

export const noTip: TipState<never> = { pointer: null, onTrigger: false, onTip: false, focus: null, lead: 'pointer', hidden: false }

/** A new hover or focus shows the tip again after Escape; moving inside the trigger does not. `enter` again on the
 *  trigger the pointer is on changes nothing, so a trigger drawn under a resting pointer can send it on a move. */
export function tipStep<T>(s: TipState<T>, e: TipEvent<T>): TipState<T> {
  switch (e.type) {
    case 'enter':
      if (s.onTrigger && Object.is(s.pointer, e.value)) return s
      return { ...s, pointer: e.value, onTrigger: true, lead: 'pointer', hidden: false }
    case 'leave': return { ...s, onTrigger: false }
    case 'tipEnter': return { ...s, onTip: true }
    case 'tipLeave': return { ...s, onTip: false }
    case 'focus': return { ...s, focus: e.value, lead: 'focus', hidden: false }
    case 'blur': return { ...s, focus: null }
    case 'escape': return { ...s, hidden: true }
  }
}

/** What the tip shows: the last of the pointer and the focus that still holds it, nothing after Escape. */
export function tipShown<T>(s: TipState<T>): T | null {
  if (s.hidden) return null
  const held = s.onTrigger || s.onTip ? s.pointer : null
  return s.lead === 'focus' ? s.focus ?? held : held ?? s.focus
}

/** While shown, Escape is heard in capture and goes no further, so the drawer, window or chat around stays open. */
export function useHoverTip<T>() {
  const [state, setState] = useState<TipState<T>>(noTip)
  const send = useCallback((e: TipEvent<T>) => setState((s) => tipStep(s, e)), [])
  const shown = tipShown(state)
  const showing = shown !== null
  useEffect(() => {
    if (!showing) return
    const { onKey } = dismissHandlers(() => null, () => send({ type: 'escape' }))
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [showing, send])
  const enter = useCallback((value: T) => send({ type: 'enter', value }), [send])
  const leave = useCallback(() => send({ type: 'leave' }), [send])
  const focus = useCallback((value: T) => send({ type: 'focus', value }), [send])
  const blur = useCallback(() => send({ type: 'blur' }), [send])
  const tipEnter = useCallback(() => send({ type: 'tipEnter' }), [send])
  const tipLeave = useCallback(() => send({ type: 'tipLeave' }), [send])
  return { shown, enter, leave, focus, blur, tip: { onMouseEnter: tipEnter, onMouseLeave: tipLeave } }
}
