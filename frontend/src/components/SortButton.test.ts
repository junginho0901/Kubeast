import { describe, expect, it, vi } from 'vitest'
import { elementsOf, textsOf } from '@/testing/fakeHooks'
import { SortButton } from './SortButton'
import { VolumeAttachmentTable } from '@/pages/storage/volumeattachments/VolumeAttachmentTable'

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
