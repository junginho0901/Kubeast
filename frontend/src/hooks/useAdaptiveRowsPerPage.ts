import { type RefObject, useLayoutEffect, useRef, useState } from 'react'

interface UseAdaptiveRowsPerPageOptions {
  // ── 숫자 추정 (폴백 모드) ─────────────────────────────
  // bodyRef 가 없으면 이 값들로 window 기준 계산.
  rowHeight?: number
  headerHeight?: number
  footerHeight?: number

  // ── 실측 모드 (정확) ──────────────────────────────────
  // bodyRef 가 주어지면 우선 사용. clientHeight 로 가용 공간을
  // 직접 재므로 화면 비율·페이지 위쪽 콘텐츠와 무관하게 정확.
  // rowRef 의 행과 그 뒤 형제 행들을 하나씩 실측, 행이 없으면 숫자 폴백.
  bodyRef?: RefObject<HTMLElement | null>
  theadRef?: RefObject<HTMLElement | null>
  rowRef?: RefObject<HTMLElement | null>

  minRows?: number
  maxRows?: number
  recalculationKey?: string | number
}

/** The elements a Fit count reads, as they are when it is worked out. */
export interface FitBox {
  container: HTMLElement | null
  body: HTMLElement | null
  thead: HTMLElement | null
  row: HTMLElement | null
}

export interface FitLimits {
  rowHeight: number
  headerHeight: number
  footerHeight: number
  minRows: number
  maxRows: number
}

export interface FitWatch {
  stop: () => void
  // After a render, before its paint: a count made from the estimate is made again once a row is drawn, and a count
  // that took rows past the last one drawn is made again from those rows once they are drawn.
  check: () => void
}

// what a row may stick out of the box by and still count as inside (the sums of fractional heights)
const EPSILON = 0.01

// The rows from `first` on (it and the rows after it) that end inside the scroll box, each at its own height: cells
// wrap as their values do, so the rows of a page differ. When every row drawn ends inside, as many more as the room
// left holds at the height of the tallest of them, and `assumed` says the count holds rows not measured. Null while
// no row has a height.
export function rowsThatFit(body: HTMLElement, first: HTMLElement): { rows: number; assumed: boolean } | null {
  const top = body.getBoundingClientRect().top + body.clientTop - body.scrollTop
  const room = body.clientHeight
  let rows = 0
  let end = 0
  let tallest = 0
  for (let el: Element | null = first; el; el = el.nextElementSibling) {
    const { bottom, height } = el.getBoundingClientRect()
    if (height <= 0) continue
    if (bottom - top > room + EPSILON) return { rows, assumed: false }
    end = bottom - top
    tallest = Math.max(tallest, height)
    rows++
  }
  if (rows === 0) return null
  const more = Math.floor((room - end + EPSILON) / tallest)
  return { rows: rows + more, assumed: more > 0 }
}

// Works the Fit row count out now, again when the box or the window changes size, and hands each count to apply, which
// says whether it changed the count drawn. A count is the rows that end inside the box, each measured. Once a count
// came from drawn rows it is the page size: turning pages puts other rows and headers of other heights in the table
// (cells wrap as the page's values do), and a new count there would start the page elsewhere, showing a row twice or
// skipping one. Until then a change of the table's content counts again, so rows that come after a count made from
// the estimate are measured; and a count that took rows past the last one drawn is made again from them in the render
// that draws them (check), before it is painted.
export function watchFitRows(read: () => FitBox, limits: FitLimits, apply: (rows: number) => boolean | void): FitWatch {
  const { rowHeight, headerHeight, footerHeight, minRows, maxRows } = limits
  let frameId = 0
  let fromRow = false
  let assumed = false
  const observers: ResizeObserver[] = []

  const calculate = () => {
    let availableRows: number
    let past = false
    const { container, body, thead, row } = read()

    if (body) {
      // 실측 모드: bodyRef 의 clientHeight = thead + tbody 가 그릴 수 있는
      // 실제 영역 (flex 배분 결과). 페이지네이션·card padding 등은 이미
      // 빠져 있으므로 별도 보정 불필요.
      if (body.clientHeight <= 0) return
      const fit = row ? rowsThatFit(body, row) : null
      if (fit) {
        availableRows = fit.rows
        past = fit.assumed
        fromRow = true
      } else {
        const th = thead?.offsetHeight ?? headerHeight
        if (rowHeight <= 0) return
        availableRows = Math.floor((body.clientHeight - th) / rowHeight)
      }
    } else {
      // 폴백 모드: 기존 동작 유지 (window - rect.top - footerHeight).
      if (!container) return
      const rect = container.getBoundingClientRect()
      const availableHeight = window.innerHeight - rect.top - footerHeight
      availableRows = Math.floor((availableHeight - headerHeight) / rowHeight) - 1
    }

    // the rows past the last one drawn come with the render this count starts; a count that changes nothing starts none
    const changed = apply(Math.max(minRows, Math.min(maxRows, availableRows))) !== false
    assumed = past && changed
  }

  const scheduleCalculate = () => {
    if (frameId) cancelAnimationFrame(frameId)
    frameId = requestAnimationFrame(calculate)
  }

  calculate()
  window.addEventListener('resize', scheduleCalculate)

  if (typeof ResizeObserver !== 'undefined') {
    const { container, body, thead, row } = read()
    // the border box: a scrollbar showing inside the box (a wider page) is no change of its size
    const box = new ResizeObserver(() => scheduleCalculate())
    for (const el of [container, body]) if (el) box.observe(el, { box: 'border-box' })
    const content = new ResizeObserver(() => {
      if (!fromRow) scheduleCalculate()
    })
    for (const el of [body?.firstElementChild, thead, row]) if (el) content.observe(el)
    observers.push(box, content)
  }

  return {
    stop: () => {
      if (frameId) cancelAnimationFrame(frameId)
      window.removeEventListener('resize', scheduleCalculate)
      for (const o of observers) o.disconnect()
    },
    check: () => {
      if (assumed || (!fromRow && read().row)) calculate()
    },
  }
}

const FIRST_COUNT = 12
// a page holds the rows that fit, down to one: none sticks out of the box for a minimum
export const FIT_LIMITS: FitLimits = { rowHeight: 46, headerHeight: 44, footerHeight: 92, minRows: 1, maxRows: 50 }

export function useAdaptiveRowsPerPage(
  containerRef: RefObject<HTMLElement | null>,
  options: UseAdaptiveRowsPerPageOptions = {},
): number {
  const {
    rowHeight = FIT_LIMITS.rowHeight,
    headerHeight = FIT_LIMITS.headerHeight,
    footerHeight = FIT_LIMITS.footerHeight,
    bodyRef,
    theadRef,
    rowRef,
    minRows = FIT_LIMITS.minRows,
    maxRows = FIT_LIMITS.maxRows,
    recalculationKey = '',
  } = options

  const [rowsPerPage, setRowsPerPage] = useState(FIRST_COUNT)
  // the count last handed to the state: a count equal to it draws nothing new
  const applied = useRef(FIRST_COUNT)
  const watch = useRef<FitWatch | null>(null)

  // Before the paint: the rows' real heights come with the rows, so a count worked out from the estimate never
  // reaches the screen. Later size changes wait for the next frame.
  useLayoutEffect(() => {
    const w = watchFitRows(
      () => ({
        container: containerRef.current,
        body: bodyRef?.current ?? null,
        thead: theadRef?.current ?? null,
        row: rowRef?.current ?? null,
      }),
      { rowHeight, headerHeight, footerHeight, minRows, maxRows },
      (next) => {
        const changed = next !== applied.current
        applied.current = next
        setRowsPerPage(next)
        return changed
      },
    )
    watch.current = w
    return () => {
      w.stop()
      if (watch.current === w) watch.current = null
    }
  }, [
    containerRef,
    bodyRef,
    theadRef,
    rowRef,
    rowHeight,
    headerHeight,
    footerHeight,
    minRows,
    maxRows,
    recalculationKey,
  ])

  // after every render, before its paint (FitWatch.check)
  useLayoutEffect(() => {
    watch.current?.check()
  })

  return rowsPerPage
}
