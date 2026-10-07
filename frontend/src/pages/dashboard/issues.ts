// Pure helpers for the Issues modal: API rows → display items, search,
// ordering (severity, then kind, then id) and the per-kind grouping.

import type { ClusterIssue } from '@/services/api/types'
import type { IssueItem, IssueKind, IssueSeverity } from './types'

export const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 }

// Kinds in display order; anything else follows alphabetically.
export const KIND_ORDER: IssueKind[] = [
  'Node', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob',
  'HorizontalPodAutoscaler', 'PersistentVolumeClaim', 'Pod', 'Collector',
]

export function kindRank(kind: IssueKind): number {
  const i = KIND_ORDER.indexOf(kind)
  return i === -1 ? KIND_ORDER.length : i
}

export function toIssueItem(issue: ClusterIssue): IssueItem {
  const subtitle = [issue.reason, issue.message].filter(Boolean).join(' · ')
  return {
    id: issue.id,
    kind: issue.kind,
    severity: issue.severity,
    title: issue.name,
    subtitle: subtitle || undefined,
    namespace: issue.namespace || undefined,
    name: issue.name,
    lastSeen: issue.last_seen,
    count: issue.count,
  }
}

export interface DerivedIssues {
  sortedIssues: IssueItem[]
  issuesByKind: Record<IssueKind, IssueItem[]>
  kinds: IssueKind[]
  issuesSummary: { total: number; critical: number; warning: number; info: number }
}

export function deriveIssues(issues: ClusterIssue[] | undefined, query: string): DerivedIssues {
  const q = query.trim().toLowerCase()
  const items = (issues ?? []).map(toIssueItem).filter((it) => {
    if (!q) return true
    return [it.kind, it.severity, it.namespace, it.name, it.subtitle]
      .filter(Boolean).join(' ').toLowerCase().includes(q)
  })
  const sortedIssues = [...items].sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || kindRank(a.kind) - kindRank(b.kind)
    || a.kind.localeCompare(b.kind)
    || a.id.localeCompare(b.id))
  const issuesByKind: Record<IssueKind, IssueItem[]> = {}
  for (const it of sortedIssues) (issuesByKind[it.kind] ??= []).push(it)
  const kinds = Object.keys(issuesByKind).sort((a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b))
  const issuesSummary = sortedIssues.reduce(
    (acc, it) => { acc.total += 1; acc[it.severity] += 1; return acc },
    { total: 0, critical: 0, warning: 0, info: 0 },
  )
  return { sortedIssues, issuesByKind, kinds, issuesSummary }
}
