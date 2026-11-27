import type { ReactNode } from 'react'

/**
 * What a sortable column header holds (WCAG 2.1.1): the `<th>` keeps its onClick, so a click anywhere in the cell
 * sorts as before, and this button gives the header a place in the Tab order — Enter or Space clicks it and the click
 * goes up to the cell. It has no onClick of its own, or a click on it would sort twice. A button centres its text, so
 * the class takes the cell's alignment, and a header of two lines reads where its cell puts it (left, or right over
 * numbers).
 */
export function SortButton({ children, className = 'inline-flex items-center gap-1 [text-align:inherit]' }: { children: ReactNode; className?: string }) {
  return (
    <button type="button" className={className}>
      {children}
    </button>
  )
}
