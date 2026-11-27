import { describe, expect, it, vi } from 'vitest'
import { elementsOf, textsOf } from '@/testing/fakeHooks'
import { SortButton } from './SortButton'
import { sortHeaderProps } from './sortHeaderProps'
import { VolumeAttachmentTable } from '@/pages/storage/volumeattachments/VolumeAttachmentTable'
import type { SortKey } from '@/pages/storage/volumeattachments/volumeAttachmentHelpers'

// A sortable column header sorted on a click of its cell only (WCAG 2.1.1): no Tab stop and no key. The cell keeps
// its click and holds a button, which the keyboard reaches and whose click (Enter or Space) goes up to the cell.

describe('a header a click sorts by', () => {
  it('holds a button that takes the Tab order and has no click of its own', () => {
    const button = SortButton({ children: 'Name' })
    expect(button.type).toBe('button')
    expect(button.props).toMatchObject({ type: 'button', className: 'inline-flex items-center gap-1', children: 'Name' })
    expect(button.props).not.toHaveProperty('onClick')
    expect(SortButton({ children: 'Name', className: 'text-left' }).props.className).toBe('text-left')
  })

  it('on a list page, each header whose cell sorts holds one with the column\'s name, and the cell sorts by it', () => {
    const setSortKey = vi.fn()
    const setSortDir = vi.fn()
    const tree = VolumeAttachmentTable({
      pagedVolumeAttachments: [], sortedVolumeAttachmentsLength: 0, isLoading: false, sortKey: null, setSortKey, sortDir: 'asc', setSortDir,
      currentPage: 1, setCurrentPage: () => {}, totalPages: 1, rowsPerPage: 25,
      tableBodyRef: { current: null }, theadRef: { current: null }, firstRowRef: { current: null },
      openDetail: () => {}, tr: (_key, fallback) => fallback,
    })
    const heads = elementsOf(tree, (props, type) => type === 'th' && typeof props.onClick === 'function')
    expect(heads.map((th) => textsOf(th).join('').trim())).toEqual(['Name', 'Attacher', 'Persistent Volume', 'Node', 'Attached', 'Error', 'Age'])
    for (const th of heads) {
      const buttons = elementsOf(th, (_props, type) => type === SortButton)
      expect(buttons).toHaveLength(1)
      expect(textsOf(buttons[0]).join('').trim()).toBe(textsOf(th).join('').trim())
    }
    ;(heads[2].props.onClick as () => void)()
    expect(setSortKey).toHaveBeenCalledWith('pv')
    expect(setSortDir).toHaveBeenCalledWith('asc')
  })
})

// The arrow beside a sorted header is hidden from a screen reader, so the order the table is in went unsaid
// (WAI-ARIA 1.2 aria-sort): the header the table is sorted by now says it, and the other sortable headers say nothing.

describe('a header a click sorts by says the order', () => {
  it('ascending or descending on the header sorted by, none on the others, and its click sorts by the same key', () => {
    const sort = vi.fn()
    const head = sortHeaderProps<'name' | 'age'>('name', 'asc', sort)
    expect(head('name')['aria-sort']).toBe('ascending')
    expect(head('age')['aria-sort']).toBeUndefined()
    expect(sortHeaderProps<'name' | 'age'>('name', 'desc', sort)('name')['aria-sort']).toBe('descending')
    expect(sortHeaderProps<'name' | 'age'>(null, 'asc', sort)('name')['aria-sort']).toBeUndefined()
    head('age').onClick()
    expect(sort).toHaveBeenCalledWith('age')
  })

  it('on a list page, changes on every press of a header and moves to another header pressed', () => {
    let sortKey: SortKey = null
    let sortDir: 'asc' | 'desc' = 'asc'
    const setSortKey = (v: SortKey | ((k: SortKey) => SortKey)) => { sortKey = typeof v === 'function' ? v(sortKey) : v }
    const setSortDir = (v: 'asc' | 'desc' | ((d: 'asc' | 'desc') => 'asc' | 'desc')) => { sortDir = typeof v === 'function' ? v(sortDir) : v }
    const heads = () => elementsOf(VolumeAttachmentTable({
      pagedVolumeAttachments: [], sortedVolumeAttachmentsLength: 0, isLoading: false, sortKey, setSortKey, sortDir, setSortDir,
      currentPage: 1, setCurrentPage: () => {}, totalPages: 1, rowsPerPage: 25,
      tableBodyRef: { current: null }, theadRef: { current: null }, firstRowRef: { current: null },
      openDetail: () => {}, tr: (_key, fallback) => fallback,
    }), (props, type) => type === 'th' && typeof props.onClick === 'function')
    const said = () => heads().map((th) => th.props['aria-sort'])
    const press = (i: number) => (heads()[i].props.onClick as () => void)()
    const none = [undefined, undefined, undefined, undefined, undefined, undefined, undefined]

    expect(said()).toEqual(none)
    press(2)
    expect(said()).toEqual([undefined, undefined, 'ascending', undefined, undefined, undefined, undefined])
    press(2)
    expect(said()).toEqual([undefined, undefined, 'descending', undefined, undefined, undefined, undefined])
    press(2)
    expect(said()).toEqual(none)
    press(0)
    press(6)
    expect(said()).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, 'ascending'])
  })
})
