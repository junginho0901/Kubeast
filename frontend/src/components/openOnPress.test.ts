import { describe, expect, it, vi } from 'vitest'
import { elementsOf } from '@/testing/fakeHooks'
import { openOnPress, opensOnKey } from './openOnPress'
import { VolumeAttachmentTable } from '@/pages/storage/volumeattachments/VolumeAttachmentTable'

// A list row opened its drawer on a click only (WCAG 2.1.1): no Tab stop and no key. The rows now take the Tab order
// and open on Enter or Space through one helper, which leaves a key on a control inside the row to that control.

const row = { tag: 'row' }
const press = (key: string, more: Partial<Parameters<typeof opensOnKey>[0]> = {}) => {
  const preventDefault = vi.fn()
  return { key, target: row, currentTarget: row, repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault, ...more } as unknown as Parameters<typeof opensOnKey>[0] & { preventDefault: ReturnType<typeof vi.fn> }
}

describe('a row that opens on a press', () => {
  it('takes the Tab order, keeps a table row a row, and reads a box outside a table as a button', () => {
    const props = openOnPress(() => {})
    expect(props.tabIndex).toBe(0)
    expect(props).not.toHaveProperty('role')
    expect(props['data-open-row']).toBe('')
    expect(openOnPress(() => {}, { button: true })).toMatchObject({ role: 'button', tabIndex: 0 })
  })

  it('opens on a click, on Enter and on Space, and Space does not scroll the page', () => {
    const open = vi.fn()
    const props = openOnPress(open)
    props.onClick()
    const enter = press('Enter')
    props.onKeyDown(enter)
    const space = press(' ')
    props.onKeyDown(space)
    expect(open).toHaveBeenCalledTimes(3)
    expect(space.preventDefault).toHaveBeenCalled()
    expect(enter.preventDefault).toHaveBeenCalled()
  })

  it('leaves a key pressed on a button or link inside the row to that control', () => {
    const open = vi.fn()
    const inner = press('Enter', { target: { tag: 'button' } as never })
    openOnPress(open).onKeyDown(inner)
    openOnPress(open).onKeyDown(press(' ', { target: { tag: 'a' } as never }))
    expect(open).not.toHaveBeenCalled()
    expect(inner.preventDefault).not.toHaveBeenCalled()
  })

  it('opens nothing on another key, a held key or a key with a modifier', () => {
    const open = vi.fn()
    const props = openOnPress(open)
    for (const e of [press('Tab'), press('a'), press('Escape'), press('Enter', { repeat: true }), press('Enter', { metaKey: true }),
      press('Enter', { ctrlKey: true }), press(' ', { shiftKey: true }), press('Enter', { altKey: true })]) props.onKeyDown(e)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('a list page with the helper', () => {
  const va = (name: string, pv: string | null) => ({ name, attacher: 'csi.example.com', node_name: 'node-1', persistent_volume_name: pv, attached: true, created_at: '2026-11-20T00:00:00Z' })
  const render = (openDetail: (t: { kind: string; name: string }) => void) => VolumeAttachmentTable({
    pagedVolumeAttachments: [va('va-1', 'pv-1'), va('va-2', null)],
    sortedVolumeAttachmentsLength: 2, isLoading: false, sortKey: null, setSortKey: () => {}, sortDir: 'asc', setSortDir: () => {},
    currentPage: 1, setCurrentPage: () => {}, totalPages: 1, rowsPerPage: 25,
    tableBodyRef: { current: null }, theadRef: { current: null }, firstRowRef: { current: null },
    openDetail, tr: (_key, fallback) => fallback,
  })
  const rowsOf = (tree: unknown) => elementsOf(tree, (props, type) => type === 'tr' && 'data-open-row' in props)

  it('opens the row\'s object on Enter, and its PV button keeps its own key and click', () => {
    const openDetail = vi.fn()
    const rows = rowsOf(render(openDetail))
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.props.tabIndex === 0 && !('role' in r.props))).toBe(true)

    const first = rows[0]
    const onKeyDown = first.props.onKeyDown as (e: unknown) => void
    onKeyDown(press('Enter', { target: first as never, currentTarget: first as never }))
    expect(openDetail).toHaveBeenCalledTimes(1)
    expect(openDetail.mock.calls[0][0]).toMatchObject({ kind: 'VolumeAttachment', name: 'va-1' })

    // Enter on the PV button inside the row comes to the row as a keydown of that button
    const [pvButton] = elementsOf(first, (props, type) => type === 'button' && typeof props.onClick === 'function')
    onKeyDown(press('Enter', { target: pvButton as never, currentTarget: first as never }))
    expect(openDetail).toHaveBeenCalledTimes(1)
    ;(pvButton.props.onClick as (e: { stopPropagation(): void }) => void)({ stopPropagation: () => {} })
    expect(openDetail).toHaveBeenLastCalledWith({ kind: 'PersistentVolume', name: 'pv-1' })
  })
})

// Every table row of the console that does something on a click is reachable from the keyboard, but those listed
// here, page rows not reached yet (rows that select, expand, go to a page or open a window).
const sources = import.meta.glob(['/src/**/*.tsx', '!/src/**/*.test.*'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const NOT_YET: Record<string, number> = {
  '/src/pages/AdminAudit.tsx': 1,
  '/src/pages/AdminUsers.tsx': 1,
  '/src/pages/Cost.tsx': 1,
  '/src/pages/admin/ClusterHygiene.tsx': 1,
  '/src/pages/alerts/AlertInbox.tsx': 1,
  '/src/pages/helm/releases/ReleaseTable.tsx': 1,
  '/src/pages/helm/tabs/HistoryTab.tsx': 1,
  '/src/pages/helm/tabs/ResourcesTab.tsx': 1,
  '/src/pages/resource-graph/PodGroupList.tsx': 2,
  '/src/pages/security/PolicyReports.tsx': 3,
}

// the opening tags `<tr …>` holding an onClick, read past the `>` inside `{…}`
function clickRowsWithoutKeys(source: string): number {
  let count = 0
  for (const m of source.matchAll(/<tr\b/g)) {
    let i = m.index! + 3
    let depth = 0
    for (; i < source.length; i++) {
      const c = source[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0 && source[i - 1] !== '=') break
    }
    const tag = source.slice(m.index, i)
    if (/\bonClick=/.test(tag) && !/openOnPress\(|tabIndex=/.test(tag)) count++
  }
  return count
}

describe('the rows the keyboard reaches', () => {
  it('are every clicked row but the ones still listed, and a listed one fixed leaves the list', () => {
    const found: Record<string, number> = {}
    for (const [path, source] of Object.entries(sources)) {
      const n = clickRowsWithoutKeys(source)
      if (n > 0) found[path] = n
    }
    expect(found).toEqual(NOT_YET)
  })

  it('include the boxes of a list page that open the drawer', () => {
    const boxes = Object.entries(sources).filter(([path, source]) => path.startsWith('/src/pages/') && /<div\b[^<]*?\bonClick=\{\(\) => openDetail\(/.test(source))
    expect(boxes.map(([path]) => path)).toEqual([])
  })
})
