import { describe, expect, it } from 'vitest'

import type { PodNodeSummary } from '@/services/api'

import { buildClusterViewSnapshot } from './useClusterAIContext'

// What the floating chat is told about Cluster View: a node is ready as kubectl prints it (the first part of STATUS),
// and while the map is searched its counts are of the pods found, next to the whole.

const nodes = ['Ready', 'NotReady', 'Unknown', 'Ready,SchedulingDisabled', 'NotReady,SchedulingDisabled'].map((status, i) => ({ name: `n${i}`, status }))
const summary: PodNodeSummary = {
  nodes: [
    { node: 'n0', total: 4, ok: 2, warn: 1, error: 1 },
    { node: '', total: 1, ok: 0, warn: 1, error: 0 },
  ],
  total: 5,
  all: 12,
  revision: 'r1',
  source: 'index',
}

describe('buildClusterViewSnapshot', () => {
  it('counts the nodes whose STATUS starts with Ready as ready', () => {
    const snap = buildClusterViewSnapshot({ nodes, summary, selectedNamespace: 'all' })!
    expect(snap.data.stats).toMatchObject({ total_nodes: 5, ready_nodes: 2, total_pods: 12, warning_pods: 2, error_pods: 1 })
    expect(snap.summary).toContain('노드 5개 (Ready 2)')
  })

  it('names the search and the pods it found, which the warnings and errors count', () => {
    const snap = buildClusterViewSnapshot({ nodes, summary, selectedNamespace: 'all', search: 'web' })!
    expect(snap.data.filters).toEqual({ namespace: 'all', search: 'web' })
    expect(snap.data.stats).toMatchObject({ total_pods: 12, matched_pods: 5, warning_pods: 2, error_pods: 1 })
    expect(snap.summary).toContain("Pod 12개 · 검색 'web' 5개 (오류 1, 주의 2)")
  })

  it('without a search there is no matched count', () => {
    const snap = buildClusterViewSnapshot({ nodes, summary, selectedNamespace: 'e2e' })!
    expect(snap.data.filters).toEqual({ namespace: 'e2e' })
    expect(snap.data.stats).not.toHaveProperty('matched_pods')
    expect(snap.data.pods_by_node).toEqual({ n0: 4, unscheduled: 1 })
  })
})
