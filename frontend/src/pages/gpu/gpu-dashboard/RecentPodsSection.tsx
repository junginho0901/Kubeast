// GPU Dashboard 의 Recent GPU Pods 테이블 (최근 created_at 5개).
//
// 추출 출처: GPUDashboard.tsx (Phase 4.11) — 빈 list 면 렌더 안 함, row 클릭 시
// ResourceDetail 열림.

import { Link } from 'react-router-dom'
import { Box, ArrowRight } from 'lucide-react'
import type { GPUPodInfo } from '@/services/api'
import { formatAge, getStatusColor } from './helpers'

interface Props {
  recentPods: GPUPodInfo[]
  openDetail: (target: { kind: string; name: string; namespace?: string }) => void
  tr: (key: string, fallback: string) => string
}

export function RecentPodsSection({ recentPods, openDetail, tr }: Props) {
  if (recentPods.length === 0) return null

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/30">
      <div className="flex items-center justify-between border-b border-slate-700/50 px-5 py-3">
        <div className="flex items-center gap-2">
          <Box className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-white">
            {tr('gpuDashboardPage.recentPods.title', 'Recent GPU Pods')}
          </h2>
        </div>
        <Link
          to="/gpu/pods"
          className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors"
        >
          {tr('gpuDashboardPage.viewAll', 'View all')}
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm table-fixed">
          <thead>
            <tr className="border-b border-slate-700/50 text-left text-xs uppercase tracking-wider text-slate-500">
              <th className="w-[17%] px-5 py-3 font-medium">{tr('gpuDashboardPage.recentPods.namespace', 'Namespace')}</th>
              <th className="w-[30%] px-5 py-3 font-medium">{tr('gpuDashboardPage.recentPods.name', 'Name')}</th>
              <th className="w-[17%] px-5 py-3 font-medium">{tr('gpuDashboardPage.recentPods.node', 'Node')}</th>
              <th className="w-[8%] px-5 py-3 font-medium">{tr('gpuDashboardPage.recentPods.gpus', 'GPUs')}</th>
              <th className="w-[13%] px-5 py-3 font-medium">{tr('gpuDashboardPage.recentPods.status', 'Status')}</th>
              <th className="w-[15%] px-5 py-3 font-medium">{tr('gpuDashboardPage.recentPods.age', 'Age')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {recentPods.map((pod: GPUPodInfo) => (
              <tr
                key={`${pod.namespace}/${pod.name}`}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDetail({ kind: 'Pod', name: pod.name, namespace: pod.namespace })}
              >
                <td className="truncate px-5 py-3 text-xs font-mono">{pod.namespace}</td>
                <td className="truncate px-5 py-3 font-medium text-white">{pod.name}</td>
                <td className="truncate px-5 py-3 text-xs font-mono">{pod.node_name ?? '-'}</td>
                <td className="truncate px-5 py-3 text-xs font-mono">{pod.gpu_requested}</td>
                <td className="px-5 py-3">
                  <span className={`badge ${getStatusColor(pod.status)}`}>{pod.status}</span>
                </td>
                <td className="truncate px-5 py-3 text-xs font-mono">{formatAge(pod.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
