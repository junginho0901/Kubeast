import { useEffect, useRef } from 'react'
import { useAdaptiveRowsPerPage } from './useAdaptiveRowsPerPage'
import { usePageSize } from '@/utils/pageSize'

// A table wider than its scroll wrapper is fitted in steps, each only when the
// one before is not enough: fold the col-optional columns (images, selectors,
// ports …), narrow the columns left by up to a fifth, then fold the col-low
// columns too (Namespace, Age, IPs) and narrow again. Measured with every column
// shown in the same frame, so nothing paints in between.
//
// In a table-fixed table, a column with no width of its own (the alert, the name)
// gets what the others leave, which is nothing once their widths add up to more
// than the box. Before any fold it is held only from going under a fifth less than
// MIN_AUTO_COLUMN (a wide screen keeps every column); once folding has started it
// is held at MIN_AUTO_COLUMN, so the steps go on and, past the last, the table scrolls.
const MIN_SCALE = 0.8
const MIN_AUTO_COLUMN = 160
const OWN_WIDTH = /(^|\s)w-(?!auto\b)\S+/

function fitTable(body: HTMLElement) {
  const table = body.firstElementChild as HTMLTableElement | null
  const head = table?.tHead?.rows[0]
  const cells = head ? Array.from(head.cells) : []
  const fixed = !!table && getComputedStyle(table).tableLayout === 'fixed'
  const auto = fixed ? cells.filter((cell) => !OWN_WIDTH.test(cell.className)) : []
  const holdAuto = (min: number) => {
    const fold = body.getAttribute('data-fold')
    for (const cell of auto) {
      cell.style.width = ''
      const folded = (fold && cell.classList.contains('col-optional')) || (fold === 'low' && cell.classList.contains('col-low'))
      if (!folded && cell.getBoundingClientRect().width < min) cell.style.width = `${min}px`
    }
  }
  for (const cell of cells) cell.style.width = ''
  body.removeAttribute('data-fold')
  holdAuto(MIN_AUTO_COLUMN * MIN_SCALE)
  if (body.scrollWidth <= body.clientWidth + 1) return
  for (const level of ['optional', 'low']) {
    body.setAttribute('data-fold', level)
    holdAuto(MIN_AUTO_COLUMN)
    const scale = body.clientWidth / body.scrollWidth
    if (scale >= 1) return
    if (scale >= MIN_SCALE) {
      const widths = cells.map((cell) => cell.getBoundingClientRect().width)
      cells.forEach((cell, i) => {
        if (widths[i] > 0) cell.style.width = `${Math.floor(widths[i] * scale)}px`
      })
      return
    }
  }
}

// Fits the table (above) on every size change, and marks the scroll wrapper
// with data-scroll-more="left|right|both" while what is left still overflows,
// so index.css can paint an edge fade + chevron (background-attachment: scroll
// keeps it pinned to the wrapper's edge). Without it a wide table just looks
// cut off. recalculationKey re-attaches it to a wrapper that mounts after a spinner.
function useScrollMoreHint(bodyRef: React.RefObject<HTMLElement | null>, recalculationKey?: string | number) {
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    let frameId = 0
    let refold = true
    const update = () => {
      frameId = 0
      if (refold) {
        refold = false
        fitTable(body)
      }
      const more = body.scrollWidth - body.clientWidth
      const left = body.scrollLeft > 1
      const right = more - body.scrollLeft > 1
      const value = left && right ? 'both' : right ? 'right' : left ? 'left' : ''
      if (value) body.setAttribute('data-scroll-more', value)
      else body.removeAttribute('data-scroll-more')
    }
    const schedule = () => {
      if (!frameId) frameId = requestAnimationFrame(update)
    }
    const resized = () => {
      refold = true
      schedule()
    }
    schedule()
    body.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', resized)
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(resized)
      observer.observe(body)
      if (body.firstElementChild) observer.observe(body.firstElementChild)
    }
    return () => {
      if (frameId) cancelAnimationFrame(frameId)
      body.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', resized)
      observer?.disconnect()
      body.removeAttribute('data-scroll-more')
      body.removeAttribute('data-fold')
    }
  }, [bodyRef, recalculationKey])
}

interface UseAdaptiveTableOptions {
  /** sorted/filtered 길이 등 — 변경 시 행 수 재계산 트리거 */
  recalculationKey?: string | number
  /** 숫자 폴백 — 측정 ref 가 비어 있을 때만 사용 */
  rowHeight?: number
  headerHeight?: number
  footerHeight?: number
  minRows?: number
  maxRows?: number
}

/**
 * useAdaptiveRowsPerPage 의 ref 실측 모드를 페이지 단에서 손쉽게 쓰도록
 * 묶은 헬퍼. ref 4개를 내부에서 만들어 반환하고, 그 ref 들을 사용해
 * rowsPerPage 를 정확히 계산한다.
 *
 * 페이지는 반환된 ref 들을 다음 위치에 부착하면 됨:
 *   - containerRef → 카드 (`<div className="card flex-1 ...">`)
 *   - bodyRef      → 내부 스크롤 wrapper (`<div className="overflow-x-auto flex-1 ...">`)
 *   - theadRef     → `<thead>`
 *   - firstRowRef  → 첫 데이터 `<tr>` (idx === 0)
 */
export function useAdaptiveTable(options: UseAdaptiveTableOptions = {}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const theadRef = useRef<HTMLTableSectionElement>(null)
  const firstRowRef = useRef<HTMLTableRowElement>(null)

  const fitRows = useAdaptiveRowsPerPage(containerRef, {
    ...options,
    bodyRef,
    theadRef,
    rowRef: firstRowRef,
  })
  // the rows-per-page choice in the footer (PageSizeSelect): fit the screen, or a fixed count that scrolls
  const pageSize = usePageSize()
  useScrollMoreHint(bodyRef, options.recalculationKey)

  return { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage: pageSize === 'fit' ? fitRows : pageSize }
}
