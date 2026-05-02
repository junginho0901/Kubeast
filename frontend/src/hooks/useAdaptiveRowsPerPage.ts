import { type RefObject, useEffect, useState } from 'react'

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
  bodyRef?: RefObject<HTMLElement>
  theadRef?: RefObject<HTMLElement>
  rowRef?: RefObject<HTMLElement>

  minRows?: number
  maxRows?: number
  recalculationKey?: string | number
}

export function useAdaptiveRowsPerPage(
  containerRef: RefObject<HTMLElement>,
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

  useEffect(() => {
    let frameId = 0
    let observer: ResizeObserver | null = null

    const calculate = () => {
      let availableRows: number

      const body = bodyRef?.current
      if (body) {
        // 실측 모드: bodyRef 의 clientHeight = thead + tbody 가 그릴 수 있는
        // 실제 영역 (flex 배분 결과). 페이지네이션·card padding 등은 이미
        // 빠져 있으므로 별도 보정 불필요.
        const bodyHeight = body.clientHeight
        const thead = theadRef?.current?.offsetHeight ?? headerHeight
        const rh = rowRef?.current?.offsetHeight ?? rowHeight
        if (rh <= 0 || bodyHeight <= 0) return
        availableRows = Math.floor((bodyHeight - thead) / rh)
      } else {
        // 폴백 모드: 기존 동작 유지 (window - rect.top - footerHeight).
        const container = containerRef.current
        if (!container) return
        const rect = container.getBoundingClientRect()
        const availableHeight = window.innerHeight - rect.top - footerHeight
        availableRows = Math.floor((availableHeight - headerHeight) / rowHeight) - 1
      }

      const nextRows = Math.max(minRows, Math.min(maxRows, availableRows))
      setRowsPerPage((prev) => (prev === nextRows ? prev : nextRows))
    }

    const scheduleCalculate = () => {
      if (frameId) cancelAnimationFrame(frameId)
      frameId = requestAnimationFrame(calculate)
    }

    scheduleCalculate()
    window.addEventListener('resize', scheduleCalculate)

    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => scheduleCalculate())
      const targets = [
        containerRef.current,
        bodyRef?.current,
        theadRef?.current,
        rowRef?.current,
      ].filter((el): el is HTMLElement => el != null)
      for (const t of targets) observer.observe(t)
    }

    return () => {
      if (frameId) cancelAnimationFrame(frameId)
      window.removeEventListener('resize', scheduleCalculate)
      observer?.disconnect()
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

  return rowsPerPage
}
