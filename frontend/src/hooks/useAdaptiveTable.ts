import { useEffect, useRef } from 'react'
import { useAdaptiveRowsPerPage } from './useAdaptiveRowsPerPage'

// Marks the scroll wrapper with data-scroll-more="left|right|both" while the
// table is wider than the wrapper, so index.css can paint an edge fade + chevron
// (background-attachment: scroll keeps it pinned to the wrapper's edge). Without
// it a wide table at 1024–1440 px just looks cut off.
function useScrollMoreHint(bodyRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    let frameId = 0
    const update = () => {
      frameId = 0
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
    schedule()
    body.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule)
      observer.observe(body)
      if (body.firstElementChild) observer.observe(body.firstElementChild)
    }
    return () => {
      if (frameId) cancelAnimationFrame(frameId)
      body.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
      body.removeAttribute('data-scroll-more')
    }
  }, [bodyRef])
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

  const rowsPerPage = useAdaptiveRowsPerPage(containerRef, {
    ...options,
    bodyRef,
    theadRef,
    rowRef: firstRowRef,
  })
  useScrollMoreHint(bodyRef)

  return { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage }
}
