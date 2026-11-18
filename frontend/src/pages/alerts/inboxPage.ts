import { answerPageSize } from '@/utils/fitServerPage'

// The page of the Alerts inbox drawn from one answer, which stays on screen while another page or count loads: its
// rows and the rows per page its range and pages are counted with. A first page asked at a count made before the rows
// were measured is cut at the rows that fit now, so that count is not drawn while the page at the new count is read.
export function inboxPage<T>(answer: { items: T[]; filter: { offset: number; limit: number } } | undefined, rowsPerPage: number) {
  if (!answer) return { rows: [] as T[], limit: rowsPerPage }
  const limit = answerPageSize(answer.filter, rowsPerPage)
  return { rows: answer.items.slice(0, limit), limit }
}
