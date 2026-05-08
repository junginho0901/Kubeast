// Resources 페이지의 Pod 탭. Resources.tsx 에서 추출 (Phase 3.5.d).
//
// Top reason 요약 (podTopSummary) 로직을 자체 useMemo 로 흡수 — 부모는
// Pod 탭이 활성일 때만 이 컴포넌트를 mount 하므로 activeTab 분기 불필요.
// 부모는 filteredPods + podLabelSelector + searchQuery + getStatusColor 만 prop.

import { useMemo } from 'react'

import { getPodReason } from './podHelpers'

interface Props {
  filteredPods: any[]
  podLabelSelector: string
  searchQuery: string
  getStatusColor: (status: string) => string
}

export function PodTab({ filteredPods, podLabelSelector, searchQuery, getStatusColor }: Props) {
  const podTopSummary = useMemo(() => {
    const list = Array.isArray(filteredPods) ? filteredPods : []
    if (list.length === 0) return { total: 0, topReasons: [] as Array<[string, number]>, phaseSummary: '', hasIssue: false }

    const reasonCounts = new Map<string, number>()
    const phaseCounts = new Map<string, number>()

    for (const pod of list) {
      const reason = getPodReason(pod)
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1)

      const phase = (pod?.phase || pod?.status || 'Unknown').toString()
      phaseCounts.set(phase, (phaseCounts.get(phase) || 0) + 1)
    }

    const topReasons = Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)

    const phaseSummary = Array.from(phaseCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k}:${v}`)
      .join(' · ')

    const hasIssue = topReasons.some(([r]) => r !== 'Running') || Array.from(phaseCounts.keys()).some((p) => p !== 'Running')
    return { total: list.length, topReasons, phaseSummary, hasIssue }
  }, [filteredPods])

  return (
    <div className="space-y-4">
      {podTopSummary.total > 0 && (podLabelSelector || searchQuery || podTopSummary.hasIssue) && (
        <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-white font-semibold">Top reason 요약</div>
            <div className="text-xs text-slate-400">pods: {podTopSummary.total}</div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {podTopSummary.topReasons.map(([reason, count]) => (
              <span
                key={reason}
                className={`badge font-mono ${
                  reason === 'Running' ? 'badge-success' : reason === 'NotReady' ? 'badge-warning' : 'badge-warning'
                }`}
                title={reason}
              >
                {reason}:{count}
              </span>
            ))}
          </div>
          {podTopSummary.phaseSummary && (
            <div className="mt-2 text-xs text-slate-500 font-mono">phase: {podTopSummary.phaseSummary}</div>
          )}
        </div>
      )}
      {filteredPods.map((pod) => (
        <div key={pod.name} className="card">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-lg font-bold text-white">{pod.name}</h3>
              <p className="text-sm text-slate-400 mt-1">Node: {pod.node_name || 'N/A'}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`badge ${getStatusColor(pod.status)}`}>
                {pod.status}
              </span>
              {pod.restart_count > 0 && (
                <span className="badge badge-warning">
                  재시작: {pod.restart_count}
                </span>
              )}
            </div>
          </div>
          <div className="mt-4 grid grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-slate-400">Phase</p>
              <p className="text-sm text-white">{pod.phase}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">IP</p>
              <p className="text-sm font-mono text-white">{pod.pod_ip || 'N/A'}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Ready</p>
              <p className="text-sm text-white">{pod.ready}</p>
            </div>
          </div>
        </div>
      ))}
      {filteredPods.length === 0 && (
        <div className="card">
          <div className="text-slate-400">(없음)</div>
        </div>
      )}
    </div>
  )
}
