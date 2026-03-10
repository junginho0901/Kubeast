import { type RefObject, useEffect, useState } from 'react'

interface UseAdaptiveRowsPerPageOptions {
  rowHeight?: number
  headerHeight?: number
  footerHeight?: number
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
    minRows = 5,
    maxRows = 50,
    recalculationKey = '',
  } = options

  const [rowsPerPage, setRowsPerPage] = useState(12)

  useEffect(() => {
    let frameId = 0
    let observer: ResizeObserver | null = null

    const calculate = () => {
      const container = containerRef.current
      if (!container) return

      const rect = container.getBoundingClientRect()
      const availableHeight = window.innerHeight - rect.top - footerHeight
      const availableRows = Math.floor((availableHeight - headerHeight) / rowHeight)
      const nextRows = Math.max(minRows, Math.min(maxRows, availableRows))
      setRowsPerPage((prev) => (prev === nextRows ? prev : nextRows))
    }

    const scheduleCalculate = () => {
      if (frameId) cancelAnimationFrame(frameId)
      frameId = requestAnimationFrame(calculate)
    }

    scheduleCalculate()
    window.addEventListener('resize', scheduleCalculate)

    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      observer = new ResizeObserver(() => scheduleCalculate())
      observer.observe(containerRef.current)
    }

    return () => {
      if (frameId) cancelAnimationFrame(frameId)
      window.removeEventListener('resize', scheduleCalculate)
      observer?.disconnect()
    }
  }, [
    containerRef,
    rowHeight,
    headerHeight,
    footerHeight,
    minRows,
    maxRows,
    recalculationKey,
  ])

  return rowsPerPage
}
