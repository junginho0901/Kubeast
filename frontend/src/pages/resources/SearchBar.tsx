// Resources 페이지 검색 바 + Pod label selector chip + 검색 결과 카운트.
// Resources.tsx 에서 추출 (Phase 3.5.a).
//
// 부모는 검색 query state + Pod label selector state + 각 탭별 필터링된 카운트
// (counts) 를 전달. counts 는 검색어 표시 줄 ("N개의 Deployment 가 검색되었습니다")
// 에만 사용.

import { Search } from 'lucide-react'
import type { ResourceType } from './types'

interface Props {
  activeTab: ResourceType
  searchQuery: string
  onSearchChange: (q: string) => void
  podLabelSelector: string
  onClearPodLabelSelector: () => void
  searchPlaceholder: Record<ResourceType, string>
  counts: Record<ResourceType, number>
}

export function SearchBar({
  activeTab,
  searchQuery,
  onSearchChange,
  podLabelSelector,
  onClearPodLabelSelector,
  searchPlaceholder,
  counts,
}: Props) {
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder={searchPlaceholder[activeTab]}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>
      {activeTab === 'pods' && podLabelSelector && (
        <div className="flex items-center justify-between gap-3 text-sm text-slate-300">
          <div className="min-w-0">
            <span className="text-slate-400">Label selector:</span>{' '}
            <span className="font-mono break-words">{podLabelSelector}</span>
          </div>
          <button
            type="button"
            onClick={onClearPodLabelSelector}
            className="text-xs text-slate-300 hover:text-white border border-slate-600 rounded px-2 py-1"
            title="라벨 셀렉터 제거"
          >
            초기화
          </button>
        </div>
      )}
      {searchQuery && (
        <p className="text-sm text-slate-400">
          {activeTab === 'deployments' && `${counts.deployments}개의 Deployment가 검색되었습니다`}
          {activeTab === 'replicasets' && `${counts.replicasets}개의 ReplicaSet이 검색되었습니다`}
          {activeTab === 'hpas' && `${counts.hpas}개의 HPA가 검색되었습니다`}
          {activeTab === 'pdbs' && `${counts.pdbs}개의 PDB가 검색되었습니다`}
          {activeTab === 'services' && `${counts.services}개의 Service가 검색되었습니다`}
          {activeTab === 'pods' && `${counts.pods}개의 Pod가 검색되었습니다`}
          {activeTab === 'pvcs' && `${counts.pvcs}개의 PVC가 검색되었습니다`}
        </p>
      )}
    </div>
  )
}
