interface AdaptiveTableFillerRowsProps {
  /** 채울 빈 행 개수 (보통 rowsPerPage - paged.length) */
  count: number
  /** 한 행에 그릴 td 개수 (테이블 컬럼 수) */
  columnCount: number
  /** td 클래스 — 페이지의 데이터 행 td 와 동일한 padding 을 주면 행 높이 일치 */
  cellClassName?: string
}

/**
 * 항목 수 < rowsPerPage 일 때 카드가 viewport 꽉 차도록 빈 placeholder 행을
 * 채워 주는 별도 tbody. divide-y 가 있는 메인 tbody 와 분리되어 있어
 * 구분선 없이 그냥 빈 공간처럼 보인다.
 *
 * 사용 예:
 *   <table>
 *     <thead ref={theadRef}>...</thead>
 *     <tbody className="divide-y ...">
 *       {paged.map((r, idx) => <tr ref={idx === 0 ? firstRowRef : undefined}>...</tr>)}
 *     </tbody>
 *     <AdaptiveTableFillerRows count={rowsPerPage - paged.length} columnCount={8} />
 *   </table>
 */
export function AdaptiveTableFillerRows({
  count,
  columnCount,
  cellClassName = 'py-3 px-4',
}: AdaptiveTableFillerRowsProps) {
  if (count <= 0) return null
  return (
    <tbody aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <tr key={`adaptive-filler-${i}`}>
          {Array.from({ length: columnCount }).map((_, j) => (
            // 첫 td 에 nbsp( ) 한 칸을 둬서 빈 행이라도 데이터 행과 같은 높이가 되도록.
            // 같은 tr 안의 다른 td 들은 자동으로 같은 행 높이를 따라감.
            <td key={j} className={cellClassName}>
              {j === 0 ? '\u00A0' : ''}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  )
}
