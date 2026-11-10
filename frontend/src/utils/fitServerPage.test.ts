import { describe, expect, it } from 'vitest'
import { FIT_FIRST_BLOCK, answerPageSize, serverPageRead } from './fitServerPage'

// Opening a server-paged Fit list is one read whatever the count is when it is worked out, and its pages, the first
// cut from that block, show every row once.

describe('serverPageRead', () => {
  it('reads the first page as one block with Fit, whatever the rows that fit', () => {
    for (const rows of [12, 11, 9, 5, 50]) expect(serverPageRead(1, rows, true)).toEqual({ offset: 0, limit: FIT_FIRST_BLOCK })
  })

  it('reads the pages after it at the rows that fit, from where the first page ends', () => {
    expect(serverPageRead(2, 9, true)).toEqual({ offset: 9, limit: 9 })
    expect(serverPageRead(3, 9, true)).toEqual({ offset: 18, limit: 9 })
  })

  it('reads a fixed choice as it is, the first page too', () => {
    expect(serverPageRead(1, 25, false)).toEqual({ offset: 0, limit: 25 })
    expect(serverPageRead(2, 25, false)).toEqual({ offset: 25, limit: 25 })
    expect(serverPageRead(1, 100, false)).toEqual({ offset: 0, limit: 100 })
  })

  it('takes no page below the first and no size below one', () => {
    expect(serverPageRead(0, 9, true)).toEqual({ offset: 0, limit: FIT_FIRST_BLOCK })
    expect(serverPageRead(2, 0, false)).toEqual({ offset: 1, limit: 1 })
  })
})

describe('answerPageSize', () => {
  it('cuts a first-page block at the rows that fit now', () => {
    expect(answerPageSize({ offset: 0, limit: FIT_FIRST_BLOCK }, 9)).toBe(9)
    expect(answerPageSize({ offset: 0, limit: FIT_FIRST_BLOCK }, 12)).toBe(12)
  })

  it('keeps any other answer at the size it was read with, while another page loads', () => {
    expect(answerPageSize({ offset: 9, limit: 9 }, 11)).toBe(9)
    expect(answerPageSize({ offset: 0, limit: 25 }, 25)).toBe(25)
    expect(answerPageSize({ offset: 0, limit: 50 }, 50)).toBe(50)
  })
})

describe('the pages of a Fit list', () => {
  it('show every row once, the first page cut from the block', () => {
    const total = 578
    const all = Array.from({ length: total }, (_, i) => i)
    const answer = (read: { offset: number; limit: number }) => all.slice(read.offset, read.offset + read.limit)
    for (let rows = 5; rows <= 50; rows++) {
      const pages = Math.ceil(total / rows)
      const seen: number[] = []
      for (let page = 1; page <= pages; page++) {
        const read = serverPageRead(page, rows, true)
        const size = answerPageSize(read, rows)
        expect(Math.floor(read.offset / size) + 1, `page ${page} at ${rows}`).toBe(page)
        seen.push(...answer(read).slice(0, size))
      }
      expect(seen, `${rows} rows per page`).toEqual(all)
    }
  })
})
