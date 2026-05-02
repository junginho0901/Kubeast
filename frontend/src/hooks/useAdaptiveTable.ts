import { useRef } from 'react'
import { useAdaptiveRowsPerPage } from './useAdaptiveRowsPerPage'

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

  return { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage }
}
