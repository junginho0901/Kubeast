// GPU Dashboard 의 3 분기 상태 JSX — isLoading / isError / empty.
//
// 추출 출처: GPUDashboard.tsx (Phase 4.11) — 본체 함수의 early return 3개를
// 컴포넌트로 분리. Loading 은 props 없음 (정적 skeleton), Error/Empty 는 tr
// + onRefetch 받음. 각 분기마다 자체 헤더 (h1 + p + refresh button) 보유 —
// 본체 main return 에도 동일 헤더가 있으나 분할로 인한 중복은 의도적
// (추상화 도입 회피, plan §0 "행동 변화 0" 원칙).

import { Monitor, RefreshCw, XCircle } from 'lucide-react'

function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-xl border border-slate-700/50 bg-slate-800/50 p-5">
      <div className="mb-3 h-4 w-24 rounded bg-slate-700" />
      <div className="h-8 w-16 rounded bg-slate-700" />
    </div>
  )
}

export function GPUDashboardLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="h-8 w-48 animate-pulse rounded bg-slate-700" />
          <div className="mt-2 h-4 w-72 animate-pulse rounded bg-slate-700" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    </div>
  )
}

interface ErrorEmptyProps {
  tr: (key: string, fallback: string) => string
  onRefetch: () => void
}

export function GPUDashboardError({ tr, onRefetch }: ErrorEmptyProps) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {tr('gpuDashboardPage.title', 'GPU Dashboard')}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {tr('gpuDashboardPage.subtitle', 'GPU resource overview across the cluster')}
          </p>
        </div>
        <button
          onClick={onRefetch}
          className="rounded-lg border border-slate-700 bg-slate-800 p-2 text-slate-300 transition-colors hover:bg-slate-700 hover:text-white"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-col items-center justify-center rounded-xl border border-red-500/20 bg-red-500/5 py-24">
        <XCircle className="mb-4 h-12 w-12 text-red-400" />
        <p className="text-lg text-red-300">
          {tr('gpuDashboardPage.error', 'Failed to load GPU data. The cluster may be temporarily unreachable.')}
        </p>
        <button
          onClick={onRefetch}
          className="mt-4 rounded-lg bg-slate-700 px-4 py-2 text-sm text-white hover:bg-slate-600"
        >
          {tr('gpuDashboardPage.retry', 'Retry')}
        </button>
      </div>
    </div>
  )
}

export function GPUDashboardEmpty({ tr, onRefetch }: ErrorEmptyProps) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {tr('gpuDashboardPage.title', 'GPU Dashboard')}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {tr('gpuDashboardPage.subtitle', 'GPU resource overview across the cluster')}
          </p>
        </div>
        <button
          onClick={onRefetch}
          className="rounded-lg border border-slate-700 bg-slate-800 p-2 text-slate-300 transition-colors hover:bg-slate-700 hover:text-white"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-col items-center justify-center rounded-xl border border-slate-700/50 bg-slate-800/30 py-24">
        <Monitor className="mb-4 h-12 w-12 text-slate-600" />
        <p className="text-lg text-slate-400">
          {tr('gpuDashboardPage.empty', 'No GPU resources detected in this cluster.')}
        </p>
      </div>
    </div>
  )
}
