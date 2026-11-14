import { pageOf } from '@/utils/listPages'
import type { IssueItem, IssueKind } from '../types'

// A dashboard window's list pages at a fixed size, as the stat cards' window does (ResourceModal): a cluster in
// trouble has thousands of issues and a big one thousands of claims and volumes, which the window drew all at once.
export const WINDOW_PAGE = 50

// One page of the Issues window: the issues in the order it lists them, kind by kind, cut at the page, then put back
// under their kind's heading, which keeps the count of the whole kind.
export interface IssueGroup { kind: IssueKind; total: number; rows: IssueItem[] }

export function issuesOnPage(kinds: readonly IssueKind[], byKind: Record<IssueKind, IssueItem[]>, page: number) {
  const flat = kinds.flatMap((kind) => (byKind[kind] ?? []).map((issue) => ({ kind, issue })))
  const shown = pageOf(flat, page, WINDOW_PAGE)
  const groups: IssueGroup[] = kinds
    .map((kind) => ({ kind, total: (byKind[kind] ?? []).length, rows: shown.rows.filter((r) => r.kind === kind).map((r) => r.issue) }))
    .filter((g) => g.rows.length > 0)
  return { groups, page: shown.page, pages: shown.pages, total: flat.length }
}
