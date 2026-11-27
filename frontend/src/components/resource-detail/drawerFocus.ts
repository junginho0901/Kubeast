import { useCallback, useEffect, useState, type RefObject } from 'react'
import { focusOrigin } from '@/components/FloatingAIChat/focusReturn'
import { namedByKey } from './crDetail'

type Doc = { activeElement: Element | null; body: Element | null; querySelector(selector: string): Element | null }
type Inside = { contains(node: Node | null): boolean; querySelectorAll(selector: string): ArrayLike<Element> }
type Focusable = { focus(options?: FocusOptions): void }

/** Where the focus goes back to as the drawer closes: the row that opened it, or the head of its list (a delete took the row). */
export type FocusBack = 'opener' | 'list'

/** The list a row is in (its table, a box marked `data-list`, else the row's parent); none for what is not in an `openOnPress` row. */
export function listOf(origin: Element | null): HTMLElement | null {
  const row = origin?.closest('[data-open-row]')
  if (!row) return null
  return (row.closest('table, [data-list]') ?? row.parentElement) as HTMLElement | null
}

/** The focus goes to the drawer's title, unless a control inside the drawer still has it. */
export function moveIn(doc: Doc, panel: Inside | null, title: Focusable | null): 'stay' | 'title' {
  const active = doc.activeElement
  if (active && active !== doc.body && panel?.contains(active)) return 'stay'
  title?.focus({ preventScroll: true })
  return 'title'
}

/**
 * The row inside the drawer that opens the object Back has just left: a cell reads its name or `<namespace>/<name>`.
 * Of several, a row that names its namespace too, then the one whose cell comes first (a table's own name column comes
 * before a column naming another object, as a PV's claim). None when that object's view shows no such row (another
 * page of its table, a list not read yet).
 */
export function rowOpening(panel: Inside | null, left: { namespace: string; name: string }): HTMLElement | null {
  const whole = `${left.namespace}/${left.name}`
  let best: { row: HTMLElement; at: number; sure: boolean } | null = null
  for (const row of Array.from(panel?.querySelectorAll('[data-open-row]') ?? [])) {
    const cells = Array.from(row.children, (cell) => cell.textContent?.trim() ?? '')
    const at = cells.findIndex((text) => text === whole || text === left.name)
    if (at < 0) continue
    const sure = cells[at] === whole || (!!left.namespace && cells.includes(left.namespace))
    if (!best || (sure && !best.sure) || (sure === best.sure && at < best.at)) best = { row: row as HTMLElement, at, sure }
  }
  return best?.row ?? null
}

/** Focuses a box outside the Tab order (a table, a list) for as long as it keeps the focus, as GOV.UK's skip link does with its target. */
export function landOn(el: HTMLElement): void {
  if (!el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1')
    el.setAttribute('data-focus-landing', '')
    el.addEventListener('blur', () => {
      el.removeAttribute('tabindex')
      el.removeAttribute('data-focus-landing')
    }, { once: true })
  }
  el.focus()
}

/**
 * As the drawer closes, with its elements gone: the focus goes back to what opened it, to the head of that row's list
 * when the row went or was deleted, and to the page's list when the drawer came from the address. A focus put outside
 * the drawer meanwhile stays where it is.
 */
export function returnFocus(doc: Doc, origin: HTMLElement | null, list: HTMLElement | null, back: FocusBack): 'stay' | 'origin' | 'list' | 'none' {
  const active = doc.activeElement
  if (active && active !== doc.body) return 'stay'
  const order = back === 'list' ? [list, origin] : [origin, list]
  if (!origin) order.push(listOf(doc.querySelector('[data-open-row]')))
  const to = order.find((el) => el?.isConnected)
  if (!to) return 'none'
  if (to === origin) {
    origin.focus()
    return 'origin'
  }
  landOn(to)
  return 'list'
}

/**
 * The drawer's focus (W3C APG Dialog, WCAG 2.4.3): on its title as it opens and when it moves to another object
 * without a control inside keeping the focus, on the row that opens the object Back left (`rowOpening`), and back
 * where it came from as it closes (`returnFocus`). The function returned says the drawer is closing on a delete of its
 * first object, so the focus goes to the list, not to the row.
 */
export function useDrawerFocus(objectKey: string, panel: RefObject<Inside | null>, title: RefObject<Focusable | null>,
  doc: Doc | null = typeof document === 'undefined' ? null : document): () => void {
  // read on the first render, before anything in the drawer takes the focus (no document: a render on the server)
  const [origin] = useState(() => (doc ? focusOrigin<HTMLElement>(doc) : null))
  const [list] = useState(() => listOf(origin))
  const [back] = useState(() => ({ to: 'opener' as FocusBack }))
  // the objects the drawer went through, the one on screen last: Back is a move to the one before it
  const [trail] = useState(() => [] as string[])
  useEffect(() => () => {
    if (doc) returnFocus(doc, origin, list, back.to)
  }, [doc, origin, list, back])
  useEffect(() => {
    if (!doc || !objectKey) return
    const left = trail[trail.length - 1]
    const isBack = trail.length > 1 && trail[trail.length - 2] === objectKey
    if (isBack) trail.pop()
    else if (left !== objectKey) trail.push(objectKey)
    const named = isBack ? namedByKey(left) : null
    const row = named && rowOpening(panel.current, named)
    if (row) row.focus()
    else moveIn(doc, panel.current, title.current)
  }, [doc, objectKey, panel, title, trail])
  return useCallback(() => {
    back.to = 'list'
  }, [back])
}
