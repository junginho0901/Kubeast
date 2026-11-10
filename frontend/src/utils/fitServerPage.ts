// A list the server pages, its rows per page the screen's Fit or the footer's fixed choice. With Fit the first page
// is read as one block and cut at the rows that fit: the block does not depend on the count, so opening the list is
// one read — not one for the count made from an estimate before a row is measured and another for the measured one
// — and a count that changes later (the window, a line above the table) reads the first page no more. The pages after
// it are read at the rows that fit, from where the first page ends, so no row shows twice or is skipped. (AG Grid's
// server-side row model keeps its block size apart from its page size the same way; the Pods list reads 50 at a time.)

export const FIT_FIRST_BLOCK = 50

export interface PageRead {
  offset: number
  limit: number
}

// The read of a page at a number of rows per page.
export function serverPageRead(page: number, rows: number, fit: boolean): PageRead {
  const size = Math.max(1, Math.floor(rows))
  const p = Math.max(1, Math.floor(page))
  if (fit && p === 1) return { offset: 0, limit: Math.max(FIT_FIRST_BLOCK, size) }
  return { offset: (p - 1) * size, limit: size }
}

// The rows per page an answer stands for: a first-page block is cut at the rows that fit now; any other answer is a
// page of the size it was read with, so the rows on screen while another page loads keep their own page and range.
export function answerPageSize(read: PageRead, rows: number): number {
  const size = Math.max(1, Math.floor(rows))
  return read.offset === 0 && read.limit > size ? size : read.limit
}
