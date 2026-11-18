import { test, expect } from '@playwright/test'

import { listsOnScreen, type GuardNode } from './list-guard'

// The list rule on its own, over trees made by hand: a list of boxes marked data-list is held to it as a table is.
// No browser, no cluster.

type El = GuardNode & { children: El[] }
const el = (tagName: string, attrs: Record<string, string> = {}, children: El[] = []): El => {
  const node: El = { tagName, children, parentElement: null, textContent: attrs.text ?? '', getAttribute: (name) => attrs[name] ?? null }
  for (const c of children) c.parentElement = node
  return node
}
const boxes = (n: number, attrs: Record<string, string> = {}) =>
  el('div', { 'data-testid': 'cluster-view-nodes', 'data-list': 'node boxes', ...attrs }, Array.from({ length: n }, () => el('div')))
const pager = (id: string) => el('div', { 'data-testid': id })
const table = (rows: number) => el('table', {}, [
  el('thead', {}, [el('tr', {}, [el('th', { text: 'Name' }), el('th', { text: 'Age' })])]),
  el('tbody', {}, Array.from({ length: rows }, () => el('tr', {}, [el('td'), el('td')]))),
])
const lists = (...children: El[]) => listsOnScreen({ root: el('main', {}, [el('div', {}, children)]) })

test.describe('the list guard', () => {
  test('a data-list list of boxes with no footer in its card is unpaged; with one beside it, it is not', () => {
    expect(lists(boxes(3)).unpaged).toEqual(['cluster-view-nodes (data-list node boxes)'])
    expect(lists(boxes(3), pager('cluster-view-nodes-pager'))).toEqual({ unpaged: [], pagers: [{ id: 'cluster-view-nodes-pager', chooser: false }] })
  })

  test('a data-list list marked bounded, or with no items, is left out', () => {
    expect(lists(boxes(3, { 'data-list-bounded': 'one object' })).unpaged).toEqual([])
    expect(lists(el('div', { 'data-list-bounded': 'the newest few' }, [boxes(3)])).unpaged).toEqual([])
    expect(lists(boxes(0)).unpaged).toEqual([])
    expect(lists(el('div', { 'data-list': 'fillers' }, [el('div', { 'aria-hidden': 'true' })])).unpaged).toEqual([])
  })

  test('a table keeps its rule, and a data-list list beside it bounds its card', () => {
    expect(lists(table(2)).unpaged).toEqual(['a table (Name | Age)'])
    // the boxes' footer is in the boxes' section, which the table's card does not take in
    const page = lists(el('section', {}, [boxes(3), pager('cluster-view-nodes-pager')]), el('section', {}, [table(2)]))
    expect(page.unpaged).toEqual(['a table (Name | Age)'])
  })
})
