import { describe, expect, it } from 'vitest'

import type { ClusterIssue } from '@/services/api/types'
import { deriveIssues, toIssueItem } from './issues'

const rows: ClusterIssue[] = [
  { id: 'Pod/a/web', kind: 'Pod', namespace: 'a', name: 'web', severity: 'warning', reason: 'Ready 0/1', message: 'Unhealthy: Readiness probe failed', last_seen: '2026-10-07T11:55:00Z', count: 12 },
  { id: 'Node/n1', kind: 'Node', name: 'n1', severity: 'critical', reason: 'NotReady' },
  { id: 'Deployment/a/api', kind: 'Deployment', namespace: 'a', name: 'api', severity: 'critical', reason: 'ProgressDeadlineExceeded', message: 'available 0/2' },
  { id: 'HorizontalPodAutoscaler/a/h', kind: 'HorizontalPodAutoscaler', namespace: 'a', name: 'h', severity: 'info', reason: 'AtMaxReplicas' },
  { id: 'Collector/jobs', kind: 'Collector', name: 'jobs', severity: 'info', reason: 'ListFailed', message: 'forbidden' },
]

describe('toIssueItem', () => {
  it('joins reason and message into the subtitle and keeps last seen / count', () => {
    const it = toIssueItem(rows[0])
    expect(it.title).toBe('web')
    expect(it.subtitle).toBe('Ready 0/1 · Unhealthy: Readiness probe failed')
    expect(it.lastSeen).toBe('2026-10-07T11:55:00Z')
    expect(it.count).toBe(12)
  })

  it('leaves the subtitle undefined when there is nothing to say', () => {
    expect(toIssueItem({ id: 'x', kind: 'Pod', name: 'x', severity: 'info' }).subtitle).toBeUndefined()
  })
})

describe('deriveIssues', () => {
  it('orders by severity, then kind order, then id, and groups per kind', () => {
    const d = deriveIssues(rows, '')
    expect(d.sortedIssues.map((i) => i.id)).toEqual([
      'Node/n1', 'Deployment/a/api', 'Pod/a/web', 'HorizontalPodAutoscaler/a/h', 'Collector/jobs',
    ])
    expect(d.kinds).toEqual(['Node', 'Deployment', 'HorizontalPodAutoscaler', 'Pod', 'Collector'])
    expect(d.issuesSummary).toEqual({ total: 5, critical: 2, warning: 1, info: 2 })
    expect(d.issuesByKind.Pod).toHaveLength(1)
  })

  it('filters on kind, severity, namespace, name and subtitle', () => {
    expect(deriveIssues(rows, 'readiness').sortedIssues.map((i) => i.id)).toEqual(['Pod/a/web'])
    expect(deriveIssues(rows, 'CRITICAL').sortedIssues).toHaveLength(2)
    expect(deriveIssues(rows, 'nothing-matches').issuesSummary.total).toBe(0)
  })

  it('handles no data', () => {
    const d = deriveIssues(undefined, '')
    expect(d.sortedIssues).toEqual([])
    expect(d.kinds).toEqual([])
    expect(d.issuesSummary.total).toBe(0)
  })
})
