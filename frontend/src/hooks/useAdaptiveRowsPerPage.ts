import { type RefObject, useLayoutEffect, useState } from 'react'

interface UseAdaptiveRowsPerPageOptions {
  // ── 숫자 추정 (폴백 모드) ─────────────────────────────
  // bodyRef 가 없으면 이 값들로 window 기준 계산.
  rowHeight?: number
  headerHeight?: number
  footerHeight?: number

  // ── 실측 모드 (정확) ──────────────────────────────────
  // bodyRef 가 주어지면 우선 사용. clientHeight 로 가용 공간을
  // 직접 재므로 화면 비율·페이지 위쪽 콘텐츠와 무관하게 정확.
  // theadRef / rowRef 는 있으면 실측, 없으면 숫자 폴백.
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

// Works the Fit row count out now, again when the box or the window changes size, and hands each count to apply.
// Once a count came from a real first row it is the page size: turning pages puts other rows and headers of other
// heights in the table (cells wrap as the page's values do), and a new count there would start the page elsewhere,
// showing a row twice or skipping one. Until then a change of the table's content counts again, so rows that come
// after a count made from the estimate are measured. Returns the function that stops watching.
export function watchFitRows(read: () => FitBox, limits: FitLimits, apply: (rows: number) => void): () => void {
  const { rowHeight, headerHeight, footerHeight, minRows, maxRows } = limits
  let frameId = 0
  let fromRow = false
  const observers: ResizeObserver[] = []

  const calculate = () => {
    let availableRows: number
    const { container, body, thead, row } = read()

    if (body) {
      // 실측 모드: bodyRef 의 clientHeight = thead + tbody 가 그릴 수 있는
      // 실제 영역 (flex 배분 결과). 페이지네이션·card padding 등은 이미
      // 빠져 있으므로 별도 보정 불필요.
      const bodyHeight = body.clientHeight
      const th = thead?.offsetHeight ?? headerHeight
      const rh = row?.offsetHeight ?? rowHeight
      if (rh <= 0 || bodyHeight <= 0) return
      availableRows = Math.floor((bodyHeight - th) / rh)
      fromRow = !!row
    } else {
      // 폴백 모드: 기존 동작 유지 (window - rect.top - footerHeight).
      if (!container) return
      const rect = container.getBoundingClientRect()
      const availableHeight = window.innerHeight - rect.top - footerHeight
      availableRows = Math.floor((availableHeight - headerHeight) / rowHeight) - 1
    }

    apply(Math.max(minRows, Math.min(maxRows, availableRows)))
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

  return () => {
    if (frameId) cancelAnimationFrame(frameId)
    window.removeEventListener('resize', scheduleCalculate)
    for (const o of observers) o.disconnect()
  }
}

export function useAdaptiveRowsPerPage(
  containerRef: RefObject<HTMLElement | null>,
  options: UseAdaptiveRowsPerPageOptions = {},
): number {
  const {
    rowHeight = 46,
    headerHeight = 44,
    footerHeight = 92,
    bodyRef,
    theadRef,
    rowRef,
    minRows = 5,
    maxRows = 50,
    recalculationKey = '',
  } = options

  const [rowsPerPage, setRowsPerPage] = useState(12)

  // Before the paint: the first row's real height comes with the rows, so a count worked out from the estimate never
  // reaches the screen. Later size changes wait for the next frame.
  useLayoutEffect(
    () =>
      watchFitRows(
        () => ({
          container: containerRef.current,
          body: bodyRef?.current ?? null,
          thead: theadRef?.current ?? null,
          row: rowRef?.current ?? null,
        }),
        { rowHeight, headerHeight, footerHeight, minRows, maxRows },
        (next) => setRowsPerPage((prev) => (prev === next ? prev : next)),
      ),
    [
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
    ],
  )

  return rowsPerPage
}
